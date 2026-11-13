/**
 * General settings of the migration, read from the environment (.env)
 */

const TRUE_VALUES = ['1', 'true', 'yes', 'on']
const FALSE_VALUES = ['', '0', 'false', 'no', 'off']

/**
 * Parse a boolean setting, refusing ambiguous values
 * @param name The environment variable
 * @param fallback The value when the variable is not set
 * @returns The boolean value
 */
export function booleanSetting(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined) {
    return fallback
  }
  const value = raw.trim().toLowerCase()
  if (TRUE_VALUES.includes(value)) return true
  if (FALSE_VALUES.includes(value)) return false
  throw new Error(`${name}='${raw}' is not a valid value: use true or false`)
}

/**
 * @returns Whether rooms without any message to migrate, or without any
 * migrated member, are left out (SKIP_EMPTY_ROOMS)
 */
export function shouldSkipEmptyRooms(): boolean {
  return booleanSetting('SKIP_EMPTY_ROOMS', false)
}

/**
 * @returns Whether SERVER_ADMINS is set (even empty): then only the users it
 * lists, and the migration admin, are Tuwunel server administrators. When it
 * is not set, the Rocket.Chat administrators become server administrators.
 */
export function serverAdminsListed(): boolean {
  return process.env.SERVER_ADMINS !== undefined
}

/**
 * @returns The entries of SERVER_ADMINS: Rocket.Chat usernames or Matrix IDs
 * of the users to make Tuwunel server administrators
 */
export function getServerAdminEntries(): string[] {
  return (process.env.SERVER_ADMINS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}
