import styled from './Documentation.module.css'

export function Setup() {
  return (
    <div className={styled.container}>
      <div className={styled.content}>
        <h1 className={styled.pageTitle}>Setup and Configuration</h1>
        <p className={styled.lead}>
          Configure Pixel's features, access control, and integrations.
        </p>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Environment Variables</h2>
          <p>
            All configuration is done through environment variables in <code>.env</code>.
            See <code>.env.example</code> for a complete list.
          </p>

          <div className={styled.configTable}>
            <h3 className={styled.subheading}>Core Settings</h3>
            <table className={styled.table}>
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Description</th>
                  <th>Required</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><code>DISCORD_TOKEN</code></td>
                  <td>Your Discord bot token</td>
                  <td>✅ Yes</td>
                </tr>
                <tr>
                  <td><code>DISCORD_APP_ID</code></td>
                  <td>Discord application ID</td>
                  <td>✅ Yes</td>
                </tr>
                <tr>
                  <td><code>DISCORD_GUILD_ID</code></td>
                  <td>The guild Pixel serves</td>
                  <td>✅ Yes</td>
                </tr>
                <tr>
                  <td><code>PIXEL_ENV</code></td>
                  <td>Environment: local, dev, or prod</td>
                  <td>No (defaults to local)</td>
                </tr>
              </tbody>
            </table>

            <h3 className={styled.subheading}>Announcements</h3>
            <table className={styled.table}>
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Description</th>
                  <th>Required</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><code>DISCORD_ANNOUNCEMENTS_CHANNEL_ID</code></td>
                  <td>Main announcements channel</td>
                  <td>No</td>
                </tr>
                <tr>
                  <td><code>DISCORD_ANNOUNCE_LIVE_CHANNEL_ID</code></td>
                  <td>Live status (one post, edited)</td>
                  <td>No</td>
                </tr>
                <tr>
                  <td><code>DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID</code></td>
                  <td>Timeline style (new post each time)</td>
                  <td>No</td>
                </tr>
                <tr>
                  <td><code>DISCORD_CLOSING_TIME_CHANNEL_ID</code></td>
                  <td>Closing time reminders</td>
                  <td>No</td>
                </tr>
              </tbody>
            </table>

            <h3 className={styled.subheading}>Home Assistant (Optional)</h3>
            <table className={styled.table}>
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Description</th>
                  <th>Required</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><code>HOME_ASSISTANT_URL</code></td>
                  <td>Home Assistant instance URL</td>
                  <td>With token</td>
                </tr>
                <tr>
                  <td><code>HOME_ASSISTANT_TOKEN</code></td>
                  <td>Long-lived access token</td>
                  <td>With URL</td>
                </tr>
              </tbody>
            </table>

            <div className={styled.note}>
              <strong>🔐 Security:</strong> Use a <strong>non-admin</strong> Home Assistant user. 
              The token can do whatever that user can, so the devices file is the real fence.
            </div>

            <h3 className={styled.subheading}>Mastodon (Optional)</h3>
            <table className={styled.table}>
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Description</th>
                  <th>Required</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><code>MASTODON_INSTANCE</code></td>
                  <td>Mastodon instance origin</td>
                  <td>With token</td>
                </tr>
                <tr>
                  <td><code>MASTODON_ACCESS_TOKEN</code></td>
                  <td>Access token (write:statuses)</td>
                  <td>With instance</td>
                </tr>
                <tr>
                  <td><code>MASTODON_VISIBILITY</code></td>
                  <td>unlisted or public (default: unlisted)</td>
                  <td>No</td>
                </tr>
              </tbody>
            </table>

            <h3 className={styled.subheading}>Observability (Optional)</h3>
            <table className={styled.table}>
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Description</th>
                  <th>Required</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><code>SENTRY_DSN</code></td>
                  <td>Sentry error tracking DSN</td>
                  <td>No</td>
                </tr>
                <tr>
                  <td><code>SENTRY_TRACES_SAMPLE_RATE</code></td>
                  <td>Trace sampling (0-1, default: 1)</td>
                  <td>No</td>
                </tr>
                <tr>
                  <td><code>LOG_LEVEL</code></td>
                  <td>Logging level (default: info)</td>
                  <td>No</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Access Control</h2>
          <p>
            Pixel uses tier-based access control with four levels:
          </p>

          <div className={styled.tierCards}>
            <div className={styled.tierCard}>
              <div className={styled.tierIcon} style={{ background: 'linear-gradient(135deg, #6b7280, #9ca3af)' }}>👤</div>
              <h3>Guest</h3>
              <p>Everyone not listed anywhere</p>
            </div>
            <div className={styled.tierCard}>
              <div className={styled.tierIcon} style={{ background: 'linear-gradient(135deg, #10b981, #34d399)' }}>🤝</div>
              <h3>Friend</h3>
              <p>Paying "friend of Pixelbar" membership</p>
            </div>
            <div className={styled.tierCard}>
              <div className={styled.tierIcon} style={{ background: 'linear-gradient(135deg, #0080ff, #00b4ff)' }}>⭐</div>
              <h3>Member</h3>
              <p>Paying Pixelbar member</p>
            </div>
            <div className={styled.tierCard}>
              <div className={styled.tierIcon} style={{ background: 'linear-gradient(135deg, #a855f7, #c084fc)' }}>👑</div>
              <h3>Admin</h3>
              <p>Pixel operators (full control)</p>
            </div>
          </div>

          <h3 className={styled.subheading}>Configuration Files</h3>
          <p>
            Tiers are managed through two YAML files in <code>config/</code>:
          </p>

          <div className={styled.step}>
            <h4 className={styled.stepTitle}>config/admins.yaml</h4>
            <pre className={styled.codeBlock}>
              <code>{`admins:
  - ids: ["discord:123456789012345678"]
    # Also needs entry in members.yaml`}</code>
            </pre>
          </div>

          <div className={styled.step}>
            <h4 className={styled.stepTitle}>config/members.yaml</h4>
            <pre className={styled.codeBlock}>
              <code>{`members:
  - ids: ["discord:123456789012345678"]
    tier: member  # member | friend | guest
    note: "Jane Doe"
    capabilities:  # optional
      - ha-lights
      - schedule-posts`}</code>
            </pre>
          </div>

          <div className={styled.warning}>
            <strong>⚠️ Important:</strong>
            <ul>
              <li>Discord IDs <strong>must be quoted strings</strong></li>
              <li>Every admin needs an entry in <code>members.yaml</code></li>
              <li>Real files are gitignored (they contain personal data)</li>
              <li>Invalid files stop startup (fail closed)</li>
            </ul>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Capabilities</h2>
          <p>
            Capabilities are named permissions granted to individuals:
          </p>

          <div className={styled.capabilityGrid}>
            <div className={styled.capabilityCard}>
              <code>ha-lights</code>
              <p>Control lights in Home Assistant</p>
            </div>
            <div className={styled.capabilityCard}>
              <code>ha-switches</code>
              <p>Control switches in Home Assistant</p>
            </div>
            <div className={styled.capabilityCard}>
              <code>ha-doors</code>
              <p>Control doors (members only)</p>
            </div>
            <div className={styled.capabilityCard}>
              <code>ha-admin</code>
              <p>Full Home Assistant control</p>
            </div>
            <div className={styled.capabilityCard}>
              <code>schedule-posts</code>
              <p>Schedule messages and polls</p>
            </div>
          </div>

          <div className={styled.note}>
            <strong>💡 Tip:</strong> Use <code>/admin capabilities grant</code> to give capabilities.
            Nothing implies a capability — not tier, not role, not being an admin.
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Home Assistant Setup</h2>
          <ol className={styled.numberedList}>
            <li>
              Create a <strong>non-admin</strong> Home Assistant user for Pixel
            </li>
            <li>
              Generate a long-lived access token for that user
            </li>
            <li>
              Add <code>HOME_ASSISTANT_URL</code> and <code>HOME_ASSISTANT_TOKEN</code> to <code>.env</code>
            </li>
            <li>
              Copy <code>config/home-assistant/devices.example.yaml</code> to{' '}
              <code>config/home-assistant/devices.yaml</code>
            </li>
            <li>
              Add allowed devices to the file (see the example for format)
            </li>
            <li>
              Run <code>just validate-config</code>
            </li>
          </ol>

          <p>
            Pixel will connect in the background and show Home Assistant status in{' '}
            <code>/admin status</code>.
          </p>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Channel Permissions</h2>
          <p>
            For each announcement channel, give Pixel these permissions:
          </p>
          <ul className={styled.list}>
            <li>✅ View Channel</li>
            <li>✅ Send Messages</li>
            <li>✅ Embed Links</li>
            <li>✅ Read Message History (for live style)</li>
          </ul>
          <p>
            Pixel checks permissions at startup and logs warnings if something is missing.
          </p>
        </section>

        <div className={styled.navigation}>
          <a href="/usage" className={styled.nextButton}>
            Next: Usage Guide →
          </a>
        </div>
      </div>
    </div>
  )
}
