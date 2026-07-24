<?php
/**
 * Plugin Name: PostHog Example
 * Description: Minimal WordPress plugin demonstrating client-side autocapture plus one server-side PostHog PHP SDK capture.
 * Version: 0.1.0
 * License: MIT
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

require __DIR__ . '/vendor/autoload.php';

use PostHog\PostHog;

/**
 * Load POSTHOG_* values from a .env file next to this plugin (dev/example
 * convenience only — a production plugin would read these from WP options
 * or wp-config.php constants instead).
 */
function posthog_example_load_env(string $path): void
{
    if (!file_exists($path)) {
        return;
    }

    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
            continue;
        }

        [$key, $value] = explode('=', $line, 2);
        $key = trim($key);
        $value = trim($value, " \t\n\r\0\x0B\"'");

        if ($key !== '' && getenv($key) === false) {
            putenv($key . '=' . $value);
        }
    }
}

function posthog_example_configured(): bool
{
    $token = getenv('POSTHOG_PROJECT_TOKEN');
    return $token && !str_starts_with($token, 'phc_your_');
}

function posthog_example_init(): void
{
    posthog_example_load_env(__DIR__ . '/.env');

    if (!posthog_example_configured()) {
        return;
    }

    PostHog::init(getenv('POSTHOG_PROJECT_TOKEN'), [
        'host' => getenv('POSTHOG_HOST') ?: 'https://us.i.posthog.com',
    ]);
}
add_action('plugins_loaded', 'posthog_example_init');

/**
 * Client-side autocapture. Same pattern as the PostHog WordPress docs
 * (https://posthog.com/docs/libraries/wordpress) — inject the JS snippet
 * on wp_head at priority 999, but sourced from env instead of hardcoded so
 * this examples repo's build/CI can inject a real project token.
 */
function posthog_example_client_snippet(): void
{
    if (!posthog_example_configured()) {
        return;
    }

    $token = esc_js(getenv('POSTHOG_PROJECT_TOKEN'));
    $host = esc_js(getenv('POSTHOG_HOST') ?: 'https://us.i.posthog.com');
    ?>
    <script>
      !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
      posthog.init('<?php echo $token; ?>',{api_host:'<?php echo $host; ?>'})
    </script>
    <?php
}
add_action('wp_head', 'posthog_example_client_snippet', 999);

/**
 * One server-side event: capture a real WordPress action (a new comment)
 * with PostHog::capture(...), then flush immediately since a PHP-FPM /
 * mod_php request has no single explicit exit point to hook otherwise.
 */
function posthog_example_track_comment(int $comment_id, $comment_approved, array $comment_data): void
{
    if (!posthog_example_configured()) {
        return;
    }

    $distinct_id = $comment_data['user_id'] ?? 'anon_' . md5($comment_data['comment_author_email'] ?? (string) $comment_id);

    PostHog::capture([
        'distinctId' => (string) $distinct_id,
        'event' => 'comment_posted',
        'properties' => [
            'comment_id' => $comment_id,
            'post_id' => $comment_data['comment_post_ID'] ?? null,
            'comment_approved' => $comment_approved,
        ],
    ]);

    PostHog::flush();
}
add_action('comment_post', 'posthog_example_track_comment', 10, 3);
