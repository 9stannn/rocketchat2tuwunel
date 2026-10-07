#!/bin/bash
set -eo pipefail
IFS=$'\n\t'

set -a # automatically export all variables
source .env
set +a

if [ -z "$HOMESERVER_URL" ]
then
  # shellcheck disable=SC2016
  echo 'Variable $HOMESERVER_URL is not set in .env. Exiting.'
  exit 1
fi

if [ -z "$REGISTRATION_SHARED_SECRET" ]
then
  # shellcheck disable=SC2016
  echo 'Variable $REGISTRATION_SHARED_SECRET is not set in .env. Exiting.'
  exit 1
fi

if [ -z "$ADMIN_USERNAME" ]
then
  # shellcheck disable=SC2016
  echo 'Variable $ADMIN_USERNAME is not set in .env. Exiting.'
  exit 1
fi

if [ -z "$ADMIN_PASSWORD" ]
then
  # shellcheck disable=SC2016
  echo 'Variable $ADMIN_PASSWORD is not set in .env. Exiting.'
  exit 1
fi

set -u

if [ "$EUID" -ne 0 ]
then
  echo 'This script must be run as root. Exiting.'
  exit 1
fi

if ! systemctl cat tuwunel.service > /dev/null 2>&1
then
  echo 'Tuwunel systemd service was not found. Exiting.'
  exit 1
fi

echo 'Stopping Tuwunel'
systemctl stop tuwunel

echo 'Resetting Tuwunel database'

if [ ! -d /var/lib/tuwunel ]
then
  echo '/var/lib/tuwunel does not exist. Exiting.'
  exit 1
fi

find /var/lib/tuwunel -mindepth 1 -delete
chown tuwunel:tuwunel /var/lib/tuwunel

rm -f db.sqlite
rm -f src/config/tuwunel_access_token.json

echo 'Starting Tuwunel'
systemctl start tuwunel

echo 'Waiting for Tuwunel'
until curl -fsS "$HOMESERVER_URL/_matrix/client/versions" > /dev/null
do
  sleep 1
done

echo 'Creating admin user'

nonce=$(curl -fsS \
  "$HOMESERVER_URL/_synapse/admin/v1/register" \
  | jq -r '.nonce')

mac=$(printf '%s\000%s\000%s\000admin' \
  "$nonce" \
  "$ADMIN_USERNAME" \
  "$ADMIN_PASSWORD" \
  | openssl dgst \
      -sha1 \
      -hmac "$REGISTRATION_SHARED_SECRET" \
      -hex \
  | awk '{print $2}')

curl -fsS \
  --request POST \
  --url "$HOMESERVER_URL/_synapse/admin/v1/register" \
  --header 'Content-Type: application/json' \
  --data "$(jq -nc \
    --arg nonce "$nonce" \
    --arg username "$ADMIN_USERNAME" \
    --arg password "$ADMIN_PASSWORD" \
    --arg mac "$mac" \
    '{
      nonce: $nonce,
      username: $username,
      password: $password,
      admin: true,
      mac: $mac
    }')" \
  > /dev/null

echo 'Saving admin access token'

mkdir -p src/config

curl -fsS \
  --request POST \
  --url "$HOMESERVER_URL/_matrix/client/v3/login" \
  --header 'Content-Type: application/json' \
  --data "$(jq -nc \
    --arg username "$ADMIN_USERNAME" \
    --arg password "$ADMIN_PASSWORD" \
    '{
      type: "m.login.password",
      user: $username,
      password: $password,
      device_id: "RCMIGRATION"
    }')" \
  > src/config/tuwunel_access_token.json

chmod 600 src/config/tuwunel_access_token.json

echo 'Removing log files'
rm -f ./*.log

echo 'Done.'