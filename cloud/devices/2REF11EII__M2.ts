import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { type TemperatureUnit } from './fridge_common'
import { Enum } from '@/util/enum'

// 2REF11EII__M2 - LG ThinQ Refrigerator
//
// ThinQ reports the same STATUS_FIELDS, but only the first nine:
//   [0] monStatus          - 0=FAIL 1=NOT_WORK 2=NORMAL 255=IGNORE.
//                            Only NORMAL has been observed so far.
//   [1] fridge temp
//   [2] freezer temp
//   [3] express/ice plus   - 1=off 2=on
//   [4] freshAirFilter
//   [5] smart grid
//   [6] waterFilter        - months since last reset
//   [7] atLeastOneDoorOpen - 0=closed 1=open
//   [8] tempUnit           - 0=Fahrenheit 1=Celsius, inverted relative to the model JSON's
//                            own enum (CELSIUS=0/FAHRENHEIT=1)
//
// F017 writes the same layout, 41 bytes, 0xFF meaning "leave unchanged".
//
// 10A8 <compartment> <0=closed 1=open> arrives alongside the 10EC for the same change.
// Each compartment (not door) reports separately: 1 is fridge, 2 is freezer.
//
// Other packets seen:
// * 10AF: Appears to be a cloud synchronisation/status frame?
//         Bytes 3 and 4 mirror setpoints.
// * F014/10AB: Smart Diagnostics
// * 1072: Unknown.

const STATUS_LEN = 9

// Express mode (called "ice plus" on this model)
const EXPRESS_ON = 2
const EXPRESS_OFF = 1

// Device can report Auto / Power / Replace. model.json reports OFF, but that's untested.
// Replace is its own special value; handle it differently.
const FRESH_AIR_MODES = Enum.of({ Auto: 2, Power: 3 })
const FRESH_AIR_REPLACE = 4

// Water filter reports in "months since last reset." Resets start at 6mo, cap at 12mo.
const WATER_FILTER_REPLACE_FROM = 6
const WATER_FILTER_MAX = 12

function waterFilterProblem(months: number) {
    if (months > WATER_FILTER_MAX) return undefined
    return months >= WATER_FILTER_REPLACE_FROM ? 'ON' : 'OFF'
}

const SMART_GRID_OPTIONS = Enum.of({
    'Not In Use': 0, // In-app as OFF
    'Seasonal Energy Saver': 2, // In-app as SMARTGRID_DD_ON
    'Peak Energy Saver': 3, // In-app as SMARTGRID_DR_ON
})

const DOOR_COMPARTMENTS: Record<number, string> = { 1: 'fridge_door', 2: 'freezer_door' }

// Per model.json, a custom map is used.
const FRIDGE_F = new Map([
    [1, 46],
    [2, 45],
    [3, 44],
    [4, 43],
    [5, 42],
    [6, 41],
    [7, 40],
    [8, 39],
    [9, 38],
    [10, 37],
    [11, 36],
    [12, 35],
    [13, 34],
    [14, 33],
])
const FREEZER_F = new Map([
    [1, 8],
    [2, 6],
    [3, 5],
    [4, 4],
    [5, 3],
    [6, 2],
    [7, 1],
    [8, 0],
    [9, -1],
    [10, -2],
    [11, -3],
    [12, -4],
    [13, -6],
])
const FRIDGE_C = new Map([
    [1, 8],
    [3, 7],
    [5, 6],
    [7, 5],
    [9, 4],
    [10, 3],
    [12, 2],
    [14, 1],
])
const FREEZER_C = new Map([
    [1, -13],
    [2, -14],
    [3, -15],
    [5, -16],
    [7, -17],
    [9, -18],
    [11, -19],
    [12, -20],
    [13, -21],
])

function invert(table: Map<number, number>): Map<number, number> {
    return new Map([...table].map(([raw, value]) => [value, raw]))
}

function range(table: Map<number, number>, unit: TemperatureUnit) {
    const values = [...table.values()]
    return { unit_of_measurement: unit === 'F' ? '°F' : '°C', min: Math.min(...values), max: Math.max(...values) }
}

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // No ACKs noted from the cloud.
        super(HA, thinq, false)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })
    }

    start() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    private tables(unit: TemperatureUnit) {
        return unit === 'F' ? { fridge: FRIDGE_F, freezer: FREEZER_F } : { fridge: FRIDGE_C, freezer: FREEZER_C }
    }

    setTemperatureUnit(unit: TemperatureUnit) {
        if (this.temperatureUnit === unit) return

        this.temperatureUnit = unit
        const { fridge, freezer } = this.tables(unit)
        this.setConfig(
            allowExtendedType({
                ...this.deviceConfig,
                components: {
                    fridge_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-fridge_setpoint',
                        state_topic: '$this/fridge_setpoint',
                        command_topic: '$this/fridge_setpoint/set',
                        name: 'Fridge temperature',
                        ...range(fridge, unit),
                    },
                    freezer_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        command_topic: '$this/freezer_setpoint/set',
                        name: 'Freezer temperature',
                        ...range(freezer, unit),
                    },
                    express_freeze: {
                        platform: 'switch',
                        icon: 'mdi:snowflake',
                        unique_id: '$deviceid-express_freeze',
                        state_topic: '$this/express_freeze',
                        command_topic: '$this/express_freeze/set',
                        name: 'Ice Plus',
                    },
                    fresh_air_filter: {
                        platform: 'select',
                        icon: 'mdi:air-filter',
                        unique_id: '$deviceid-fresh_air_filter',
                        state_topic: '$this/fresh_air_filter',
                        command_topic: '$this/fresh_air_filter/set',
                        name: 'Fresh air filter mode',
                        options: FRESH_AIR_MODES.options,
                    },
                    water_filter: {
                        platform: 'binary_sensor',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                        icon: 'mdi:water-opacity',
                        unique_id: '$deviceid-water_filter',
                        state_topic: '$this/water_filter',
                        name: 'Water filter health',
                    },
                    water_filter_months: {
                        platform: 'sensor',
                        entity_category: 'diagnostic',
                        unique_id: '$deviceid-water_filter_months',
                        state_topic: '$this/water_filter_months',
                        name: 'Water filter months',
                        icon: 'mdi:calendar-clock',
                        unit_of_measurement: 'months',
                        suggested_display_precision: 0,
                    },
                    fresh_air_filter_replace: {
                        platform: 'binary_sensor',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                        icon: 'mdi:air-filter',
                        unique_id: '$deviceid-fresh_air_filter_replace',
                        state_topic: '$this/fresh_air_filter_replace',
                        name: 'Fresh air filter health',
                    },
                    smart_grid: {
                        platform: 'select',
                        icon: 'mdi:transmission-tower',
                        unique_id: '$deviceid-smart_grid',
                        state_topic: '$this/smart_grid',
                        command_topic: '$this/smart_grid/set',
                        name: 'Smart Grid',
                        options: SMART_GRID_OPTIONS.options,
                    },
                    fridge_door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-fridge_door',
                        state_topic: '$this/fridge_door',
                        name: 'Fridge door',
                    },
                    freezer_door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-freezer_door',
                        state_topic: '$this/freezer_door',
                        name: 'Freezer door',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x10) return

        if (buf[1] === 0xa8 && buf.length === 4) {
            // 10A8 <compartment> <0=closed 1=open>
            const compartment = DOOR_COMPARTMENTS[buf[2]]
            if (compartment) this.publishProperty(compartment, buf[3] === 1 ? 'ON' : 'OFF')
            return
        }

        if (buf[1] !== 0xec && buf[1] !== 0xeb) return

        if (buf[1] === 0xec && buf.length === 2 + STATUS_LEN * 2) {
            // 10EC: [prev status][cur status]
            this.processStatus(buf.subarray(2 + STATUS_LEN, 2 + STATUS_LEN * 2))
        } else if (buf[1] === 0xeb && buf.length === 2 + STATUS_LEN) {
            // 10EB: [initial status]
            this.processStatus(buf.subarray(2, 2 + STATUS_LEN))
        } else {
            console.warn(`${this.id}: unexpected ${buf.subarray(0, 2).toString('hex')} status length ${buf.length}`)
        }
    }

    processStatus(curStatus: Buffer) {
        const unit: TemperatureUnit = curStatus[8] ? 'C' : 'F'
        this.setTemperatureUnit(unit)
        const { fridge, freezer } = this.tables(unit)

        this.publishProperty('fridge_setpoint', fridge.get(curStatus[1]))
        this.publishProperty('freezer_setpoint', freezer.get(curStatus[2]))
        this.publishProperty('express_freeze', curStatus[3] === EXPRESS_ON ? 'ON' : 'OFF')

        const freshAirMode = FRESH_AIR_MODES.map(curStatus[4])
        if (freshAirMode !== undefined) this.publishProperty('fresh_air_filter', freshAirMode)
        this.publishProperty('fresh_air_filter_replace', curStatus[4] === FRESH_AIR_REPLACE ? 'ON' : 'OFF')

        this.publishProperty('smart_grid', SMART_GRID_OPTIONS.map(curStatus[5]))

        const waterFilterMonths = curStatus[6]
        this.publishProperty('water_filter', waterFilterProblem(waterFilterMonths))
        this.publishProperty(
            'water_filter_months',
            waterFilterMonths <= WATER_FILTER_MAX ? waterFilterMonths : undefined,
        )

        // fridge_common notes some models use 2 as a second "closed" value
        const anyDoorOpen = curStatus[7] === 1
        if (!anyDoorOpen) {
            for (const compartment of Object.values(DOOR_COMPARTMENTS)) {
                this.publishProperty(compartment, 'OFF')
            }
        }
    }

    setProperty(prop: string, mqttValue: string) {
        const unit = this.temperatureUnit || 'F'
        const { fridge, freezer } = this.tables(unit)

        const baseMessage = Buffer.from(
            'F017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF',
            'hex',
        )

        if (prop === 'fridge_setpoint' || prop === 'freezer_setpoint') {
            const isFridge = prop === 'fridge_setpoint'
            const raw = invert(isFridge ? fridge : freezer).get(Number(mqttValue))
            if (raw === undefined) {
                console.warn(`${prop}: no ${unit} code for ${mqttValue}`)
                return
            }
            baseMessage[2 + (isFridge ? 1 : 2)] = raw
            baseMessage[2 + 8] = unit === 'C' ? 1 : 0
            this.send(baseMessage)
        } else if (prop === 'fresh_air_filter') {
            const code = FRESH_AIR_MODES.unmap(mqttValue)
            if (code === undefined) {
                console.warn(`${prop}: cannot be set to ${mqttValue}`)
                return
            }
            baseMessage[2 + 4] = code
            this.send(baseMessage)
        } else if (prop === 'smart_grid') {
            const code = SMART_GRID_OPTIONS.unmap(mqttValue)
            if (code === undefined) console.warn(`Unexpected value ${mqttValue}`)
            else {
                baseMessage[2 + 5] = code
                this.send(baseMessage)
            }
        } else if (prop === 'express_freeze') {
            baseMessage[2 + 3] = mqttValue === 'ON' ? EXPRESS_ON : EXPRESS_OFF
            this.send(baseMessage)
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
