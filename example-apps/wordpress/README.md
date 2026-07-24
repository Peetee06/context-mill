# PostHog WordPress Example

A minimal WordPress plugin demonstrating PostHog integration for self-hosted WordPress sites: client-side autocapture plus one server-side capture call via the PHP SDK.

## Why a plugin, not `functions.php`

The existing PostHog WordPress docs teach editing a theme's `functions.php` for the client snippet, which is theme-coupled and has no path to server-side capture. This example uses a small standalone plugin instead — the same approach a real integration on self-hosted WordPress (VIP, WP Engine, Pantheon, or any host with file access) would take.

## Features Demonstrated

- **Client-side autocapture** — the same `wp_head` JS-snippet pattern as the PostHog WordPress docs, sourced from env instead of hardcoded
- **One server-side event** — captures a real WordPress action (`comment_post`) with `PostHog::capture(...)`, then flushes immediately since a PHP-FPM/mod_php request has no single explicit exit point

## Quick Start

```bash
cd posthog-example
composer install
cp .env.example .env
# edit .env and add your PostHog project token
```

Drop `posthog-example/` into any WordPress install's `wp-content/plugins/` directory and activate it.

## What Gets Tracked

| Event | Trigger | Properties |
|-------|---------|------------|
| `$pageview` (autocapture) | Any page load | Standard PostHog JS autocapture |
| `comment_posted` | `comment_post` action | `comment_id`, `post_id`, `comment_approved` |

## Learn More

- [PostHog WordPress docs](https://posthog.com/docs/libraries/wordpress)
- [PostHog PHP SDK docs](https://posthog.com/docs/libraries/php)
