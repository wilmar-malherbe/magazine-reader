# MagShelf

MagShelf is a small, self-hosted PDF magazine library. An administrator uploads
PDF issues and optional cover images; visitors browse the shelf and read each
issue in a responsive browser flipbook.

It is designed for a home server, TrueNAS Scale, or any Docker host. There is no
cloud storage or external database: the SQLite database, sessions, PDFs, and
covers all live under one mounted `/data` directory.

## Features

- Responsive library, admin dashboard, and reader for phones, tablets, and desktops
- Single-page phone reader and two-page desktop spreads
- Lazy PDF.js page rendering, touch swipes, keyboard controls, zoom/pan, and fullscreen
- Environment-controlled single administrator account
- Publish/unpublish, metadata editing, PDF replacement, and coordinated deletion
- File-signature validation, safe generated names, protected media routes, and login rate limiting
- Local PDF.js and StPageFlip assets with no CDN dependency

## Screenshots

Screenshots can be added here after deploying with your own collection:

- Library shelf — `docs/screenshots/library.png`
- Mobile reader — `docs/screenshots/mobile-reader.png`
- Admin dashboard — `docs/screenshots/admin.png`

## Quick start with Docker Compose

1. Copy the example environment file:

   ```sh
   cp .env.example .env
   ```

2. Replace `ADMIN_PASSWORD` and `SESSION_SECRET` in `.env`. Generate a session
   secret with:

   ```sh
   openssl rand -hex 32
   ```

3. Create the local data directory and make it writable by the container's
   unprivileged user (UID 1000):

   ```sh
   mkdir -p data
   sudo chown -R 1000:1000 data
   ```

4. Start MagShelf:

   ```sh
   docker compose up -d --build
   ```

5. Open `http://localhost:3000`, then use **Admin login** in the footer to
   upload the first magazine.

The image runs read-only as an unprivileged user; only the mounted `/data`
directory is writable.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `ADMIN_USERNAME` | Yes | Administrator login name |
| `ADMIN_PASSWORD` | Yes | Administrator password; use a long unique value |
| `SESSION_SECRET` | Yes | Long random value used to sign session cookies |
| `PORT` | Yes | HTTP port (`3000` in the container) |
| `DATA_DIR` | Yes | Persistent storage root (`/data` in the container) |
| `PUBLIC_BASE_URL` | Yes | Browser-facing absolute URL |
| `APP_NAME` | No | Site name; defaults to `MagShelf` |
| `MAX_UPLOAD_MB` | No | Maximum size per uploaded file; defaults to `500` |
| `ALLOW_PUBLIC_DOWNLOAD` | No | Show public download actions; `true` or `false` |
| `MAGSHELF_DATA_PATH` | Compose only | Host path mounted at `/data`; defaults to `./data` |

Disabling public downloads removes download buttons, but it cannot prevent a
visitor who can read a magazine from saving the PDF data delivered to their
browser.

## Local development

MagShelf requires Node.js 24 or newer.

```sh
npm install
cp .env.example .env
```

For local development, change `DATA_DIR` in `.env` to an absolute writable
directory, then run:

```sh
npm run dev
```

Run the server and integration suite:

```sh
npm test
```

Run responsive browser tests (first install Chromium once):

```sh
npx playwright install chromium
npm run test:e2e
```

## TrueNAS Scale

1. Create a dataset such as:

   ```txt
   /mnt/tank/apps/magshelf/data
   ```

2. Give UID/GID `1000` write access to that dataset, or configure an ACL that
   grants it read/write/execute access.
3. Set the Compose host path in `.env`:

   ```env
   MAGSHELF_DATA_PATH=/mnt/tank/apps/magshelf/data
   PUBLIC_BASE_URL=http://TRUENAS-IP:3000
   ```

4. Deploy this repository as a TrueNAS custom Docker Compose app.
5. Expose port `3000`, or place it behind an HTTPS reverse proxy.

When using a reverse proxy, forward the original protocol (`X-Forwarded-Proto`).
MagShelf trusts one proxy hop and automatically marks its session cookie secure
for HTTPS requests.

## Storage and backups

MagShelf creates:

```txt
/data/magshelf.sqlite
/data/magshelf.sqlite-wal
/data/magshelf.sqlite-shm
/data/uploads/pdfs/
/data/uploads/covers/
/data/uploads/tmp/
```

Sessions are stored inside the same SQLite database. To back up:

1. Stop the container with `docker compose stop`.
2. Back up the entire mounted `/data` directory.
3. Start it again with `docker compose start`.

To restore, stop MagShelf, replace the complete `/data` directory with the
backup, confirm ownership is still UID/GID `1000`, and restart.

## Security notes

- Do not commit `.env`; it is ignored by Git.
- Use HTTPS when exposing MagShelf outside your trusted network.
- Use a unique administrator password and a random session secret.
- The administrator password is read from the environment and is never written
  to SQLite.
- Uploaded media is served only through validated routes. Unpublished issues
  and their files require an authenticated administrator session.
- Back up `/data` regularly and keep the host and container image updated.

MagShelf is intentionally a single-admin application. Multiple users, external
authentication, analytics, categories, and server-side PDF conversion are
outside version 1.
