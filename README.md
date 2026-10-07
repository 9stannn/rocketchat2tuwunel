# Rocket.Chat to Tuwunel Migration Script

Script to migrate users, channels and messages from Rocket.Chat communication platform to a Tuwunel Matrix homeserver.

It currently has beta quality and comes with no warranty.

## Installation and Usage

This setup is intended to migrate from Rocket.Chat to Tuwunel once, using MongoDB dumps and preferably a fresh Tuwunel instance.

### Exporting RC data

Currently manually via MongoDB. Run the following on the Rocket.Chat server:

```shell
mongoexport --collection=rocketchat_message --db=rocketchat --out=rocketchat_message.json
mongoexport --collection=rocketchat_room --db=rocketchat --out=rocketchat_room.json
mongoexport --collection=users --db=rocketchat --out=users.json
```

Copy them to `inputs/`.

### Configuring Tuwunel

Copy the environment example:

```shell
cp .env.example .env
```

Edit `.env` and configure at least:

```env
HOMESERVER_URL='http://localhost:8008'
TUWUNEL_SERVER_NAME='my.matrix.host'
REGISTRATION_SHARED_SECRET='change-me'
AS_TOKEN='change-me'
EXCLUDED_USERS='rocket.cat'
ADMIN_USERNAME='admin'
ADMIN_PASSWORD='verySecretPassword'
```

Choose `TUWUNEL_SERVER_NAME` carefully before starting Tuwunel. It becomes part of Matrix user IDs and should not be changed afterwards.

Generate strong random secrets, for example:

```shell
openssl rand -hex 32
```

### Configuring the Application Service

Create the Application Service directory:

```shell
mkdir -p files/appservices
```

Copy the example configuration:

```shell
cp app-service.example.yaml files/appservices/rocketchat2matrix.yaml
```

Edit `files/appservices/rocketchat2matrix.yaml`.

The `as_token` must be the same value as `AS_TOKEN` in `.env`.

Generate a separate random `hs_token`.

Tuwunel loads this Application Service when the container starts. Tuwunel supports Application Service registration files using the standard Matrix YAML format.

### Installing the Script

Install NodeJS >= v19 and npm.

Install the dependencies:

```shell
npm ci
```

### Starting Tuwunel

The included Docker Compose configuration starts a local Tuwunel instance on port `8008`.

For the first setup, run:

```shell
./reset.sh
```

The reset script:

- removes the previous Tuwunel test database
- starts a fresh Tuwunel instance
- creates the Matrix admin user
- stores its access token for the migration script
- clears the local migration database and logs

Tuwunel's Docker image supports configuration through `TUWUNEL_*` environment variables.

### Running the Migration

Run:

```shell
npm start
```

The migration can be restarted if it is interrupted. Existing mappings are stored locally so already migrated objects are not blindly recreated.

A completed migration ends with:

```text
info: Done.
```

### Migrated User Passwords

Rocket.Chat user passwords cannot be migrated.

Tuwunel requires a non-empty password when users are created, so this fork generates a random password for each migrated user.

After migration, users therefore need either:

- a Matrix password reset
- SSO / external authentication

The migration admin keeps the password configured with `ADMIN_PASSWORD`.

### Running Tests

```shell
npm test
```

### Cleaning Up

To reset the complete migration environment:

```shell
./reset.sh
```

Before using the migrated homeserver in production, remove migration-only credentials such as the registration shared secret and Application Service if they are no longer required.

## Design Decisions

- Getting data from Rocket.Chat via manual mongodb export
- Room to Channel conversion:
  - Read-only attributes of channels not converted to power levels due to complexity
- Reactions and emojis:
  - So far only reactions used in our chats have been translated
  - To add more, `src/emojis.json` can be modified (PRs with additions are appreciated)
    - These mappings take precedence over the used translation library
  - Individual logos of _netzbegruenung_ and _verdigado_ have been replaced by a generic sunflower
  - Skin colour tones and genders have been ignored in the manual translation, using the neutral versions
- Discussions are not translated, yet, as they have a channel-like data structure which probably should be translated to threads
- Generally state change events are not translated (anymore, for the sake of complexity), but the final state should be equal
  - Memberships: change events are ignored. Memberships are applied at the start, when needed or terminated at the end
  - Name changes: as the previous state is usually unknown, they are ignored
- If the root message of a thread is deleted or of a deleted user, the thread will be skipped
- The script follows a design to easily continue a migration if the script crashed by restarting it
- Any normal username containing the configured admin name causes trouble

## Contributing

This FOSS project is open for contributions. Just open an issue or a pull request.

### Hint: pre-commit

To keep the code clean and properly formatted, install and use [`pre-commit`](https://pre-commit.com/).

- Install it via `pip install pre-commit`
- Install the repo's pre-commit hooks for yourself: `pre-commit install`.

  Now it will run whenever you commit something

- Run pre-commit against all files: `pre-commit run --all-files`

## License

Licensed under AGPL v3 or newer.

Original project Copyright 2023 verdigado eG
<support@verdigado.com>.

This fork includes modifications for Tuwunel support.

## Support

For issues related to this fork, please use the GitHub issue tracker.

Original project:
https://github.com/verdigado/rocketchat2matrix