import styled from './Documentation.module.css'

export function Interact() {
  return (
    <div className={styled.container}>
      <div className={styled.content}>
        <h1 className={styled.pageTitle}>How to Interact with Pixel</h1>
        <p className={styled.lead}>
          Best practices and tips for working with Pixel in your hackerspace.
        </p>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Getting Started</h2>
          <p>
            Pixel uses Discord slash commands for all interactions. Type <code>/</code> in any channel
            where Pixel is present to see available commands.
          </p>

          <div className={styled.card}>
            <h3 className={styled.subheading}>First Steps</h3>
            <ol className={styled.numberedList}>
              <li>Type <code>/whoami</code> to check your access level</li>
              <li>Type <code>/help</code> to see which commands you can use</li>
              <li>Try <code>/status</code> to see if the space is open</li>
              <li>Use <code>/events</code> to see what's coming up</li>
            </ol>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Command Visibility</h2>
          <p>
            Discord shows all registered commands to everyone, but Pixel enforces access control:
          </p>

          <div className={styled.infoBox}>
            <p><strong>✅ What you see:</strong> All commands in Discord's autocomplete</p>
            <p><strong>🔒 What you can run:</strong> Only commands for your tier and capabilities</p>
            <p><strong>📝 What /help shows:</strong> Only commands you have access to</p>
          </div>

          <div className={styled.note}>
            <strong>💡 Tip:</strong> Admins can configure Discord to hide admin commands from non-admins.
            See <code>docs/discord-command-visibility.md</code> in the repository.
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Access Levels Explained</h2>
          
          <div className={styled.accessGrid}>
            <div className={styled.accessCard}>
              <div className={styled.accessIcon}>👤</div>
              <h3>Guest</h3>
              <p className={styled.accessDescription}>
                Default level for everyone in the Discord server.
              </p>
              <h4 className={styled.accessSubheading}>Can do:</h4>
              <ul className={styled.accessList}>
                <li>Check space status</li>
                <li>View events</li>
                <li>Read info topics</li>
                <li>Send feedback</li>
              </ul>
            </div>

            <div className={styled.accessCard}>
              <div className={styled.accessIcon}>🤝</div>
              <h3>Friend</h3>
              <p className={styled.accessDescription}>
                "Friend of Pixelbar" paid membership.
              </p>
              <h4 className={styled.accessSubheading}>Additional access:</h4>
              <ul className={styled.accessList}>
                <li>View Home Assistant devices</li>
                <li>Check device status</li>
                <li>Control devices (with capabilities)</li>
              </ul>
            </div>

            <div className={styled.accessCard}>
              <div className={styled.accessIcon}>⭐</div>
              <h3>Member</h3>
              <p className={styled.accessDescription}>
                Full Pixelbar member (paid membership).
              </p>
              <h4 className={styled.accessSubheading}>Additional access:</h4>
              <ul className={styled.accessList}>
                <li>Post closing-time reminders</li>
                <li>Schedule posts (with capability)</li>
                <li>Control doors (with capability)</li>
              </ul>
            </div>

            <div className={styled.accessCard}>
              <div className={styled.accessIcon}>👑</div>
              <h3>Admin</h3>
              <p className={styled.accessDescription}>
                Pixel operators with full control.
              </p>
              <h4 className={styled.accessSubheading}>Additional access:</h4>
              <ul className={styled.accessList}>
                <li>Manage user tiers</li>
                <li>Grant/revoke capabilities</li>
                <li>Emergency switches</li>
                <li>System configuration</li>
              </ul>
            </div>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Announcements</h2>
          <p>
            Pixel keeps you informed about the space automatically:
          </p>

          <div className={styled.featureList}>
            <div className={styled.featureItem}>
              <h3 className={styled.featureItemTitle}>🟢 Space Opens</h3>
              <p>Posted to the configured announcement channels when Pixelbar opens</p>
            </div>

            <div className={styled.featureItem}>
              <h3 className={styled.featureItemTitle}>🔴 Space Closes</h3>
              <p>Posted when the space closes, with how long it was open</p>
            </div>

            <div className={styled.featureItem}>
              <h3 className={styled.featureItemTitle}>🕐 Closing Time</h3>
              <p>Automatic reminder posted when the space closes</p>
            </div>

            <div className={styled.featureItem}>
              <h3 className={styled.featureItemTitle}>🤖 Bot Status</h3>
              <p>Pixel announces when it comes online or goes offline</p>
            </div>
          </div>

          <div className={styled.infoBox}>
            <p><strong>Two Styles:</strong></p>
            <ul className={styled.list}>
              <li><strong>Live:</strong> One post per opening, edited to "closed" when space closes</li>
              <li><strong>Timeline:</strong> New post for every open and close (full history)</li>
            </ul>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Best Practices</h2>
          
          <div className={styled.card}>
            <h3 className={styled.subheading}>For Everyone</h3>
            <ul className={styled.list}>
              <li>Use <code>/help</code> to discover what you can do</li>
              <li>Commands are ephemeral (private) when they show personal info</li>
              <li>Use <code>/feedback</code> to report issues or suggest features</li>
              <li>Check <code>/events</code> before heading to the space</li>
            </ul>

            <h3 className={styled.subheading}>For Members</h3>
            <ul className={styled.list}>
              <li>Schedule recurring posts for events you organize</li>
              <li>Use template tokens like <code>{`{{date}}`}</code> in scheduled messages</li>
              <li>Preview scheduled posts with <code>/schedule preview</code> before they go live</li>
              <li>Remember to run <code>/closing-time</code> when you're the last one leaving</li>
            </ul>

            <h3 className={styled.subheading}>For Admins</h3>
            <ul className={styled.list}>
              <li>Run <code>/admin status</code> after deploy to check everything is healthy</li>
              <li>Use <code>/admin reload</code> after hand-editing config files</li>
              <li>Always include a reason when changing tiers or capabilities</li>
              <li>Use <code>/admin sync</code> if Discord roles and Pixel tiers diverge</li>
              <li>Keep <code>admins.yaml</code> and <code>members.yaml</code> backed up</li>
            </ul>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Rate Limits</h2>
          <p>
            Pixel has rate limiting to prevent abuse:
          </p>
          <ul className={styled.list}>
            <li><strong>Commands:</strong> In-memory token bucket per user</li>
            <li><strong>Autocomplete:</strong> More generous limit (typing shouldn't use up your budget)</li>
            <li><strong>Feedback:</strong> A few at once, then one every 10 minutes</li>
          </ul>
          <p>
            If you hit a rate limit, wait a moment and try again. Limits reset quickly.
          </p>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Privacy & Security</h2>
          
          <div className={styled.card}>
            <h3 className={styled.subheading}>What Pixel Logs</h3>
            <ul className={styled.list}>
              <li>✅ Your Discord ID (immutable, used for authentication)</li>
              <li>✅ Your display name and handle (for human recognition)</li>
              <li>✅ Commands you run and their outcomes</li>
              <li>✅ Access denials and rate limits</li>
              <li>❌ Message content (except in <code>/feedback</code>)</li>
              <li>❌ Command arguments (except in audit logs for tier/capability changes)</li>
            </ul>

            <h3 className={styled.subheading}>Where Data Goes</h3>
            <ul className={styled.list}>
              <li><strong>Console logs:</strong> JSON output (local dev has pretty printing)</li>
              <li><strong>Rotating file:</strong> About 2 weeks retention</li>
              <li><strong>Sentry:</strong> Errors, traces, and structured logs</li>
            </ul>

            <h3 className={styled.subheading}>Your Rights</h3>
            <p>
              Under GDPR, you have the right to access your data and request deletion.
              Contact the Pixelbar board at <code>bestuur@pixelbar.nl</code>.
            </p>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Getting Help</h2>
          
          <div className={styled.helpGrid}>
            <div className={styled.helpCard}>
              <h3>💬 In Discord</h3>
              <p>Use <code>/feedback</code> to send a message to maintainers</p>
            </div>

            <div className={styled.helpCard}>
              <h3>📖 Documentation</h3>
              <p>Check the repository docs at <code>docs/</code></p>
            </div>

            <div className={styled.helpCard}>
              <h3>🐛 Found a Bug?</h3>
              <p>Open an issue on GitHub or use <code>/feedback</code></p>
            </div>

            <div className={styled.helpCard}>
              <h3>💡 Feature Ideas</h3>
              <p>Discuss with the community and open an issue</p>
            </div>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Common Questions</h2>
          
          <div className={styled.faq}>
            <div className={styled.faqItem}>
              <h3 className={styled.faqQuestion}>Why can't I see some commands?</h3>
              <p className={styled.faqAnswer}>
                Use <code>/help</code> to see which commands you have access to. Discord shows all
                commands, but Pixel only allows those matching your tier and capabilities.
              </p>
            </div>

            <div className={styled.faqItem}>
              <h3 className={styled.faqQuestion}>How do I get capabilities?</h3>
              <p className={styled.faqAnswer}>
                Capabilities are granted by admins using <code>/admin capabilities grant</code>.
                You'll receive a DM when a capability is granted or revoked.
              </p>
            </div>

            <div className={styled.faqItem}>
              <h3 className={styled.faqQuestion}>What if Pixel is offline?</h3>
              <p className={styled.faqAnswer}>
                Admins are notified via Sentry when Pixel goes down. Check the announcements channel
                for status updates. The bot posts when it comes back online.
              </p>
            </div>

            <div className={styled.faqItem}>
              <h3 className={styled.faqQuestion}>Can I test commands safely?</h3>
              <p className={styled.faqAnswer}>
                Most commands are read-only or show previews. Commands that change things (like Home
                Assistant control) clearly state what they do and log who did it.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
