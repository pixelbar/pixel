import styled from './Documentation.module.css'

export function Usage() {
  return (
    <div className={styled.container}>
      <div className={styled.content}>
        <h1 className={styled.pageTitle}>Usage Guide</h1>
        <p className={styled.lead}>
          Learn how to use Pixel's features and commands effectively.
        </p>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Core Commands</h2>
          
          <div className={styled.commandList}>
            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/help</code>
                <span className={styled.tier}>Guest</span>
              </div>
              <p className={styled.commandDescription}>
                Lists all commands you have access to. Only shows commands you can run.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/ping</code>
                <span className={styled.tier}>Guest</span>
              </div>
              <p className={styled.commandDescription}>
                Check if Pixel is responsive. Shows version and uptime.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/whoami</code>
                <span className={styled.tier}>Guest</span>
              </div>
              <p className={styled.commandDescription}>
                Private reply showing your Discord ID and effective tier in Pixel.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/status</code>
                <span className={styled.tier}>Guest</span>
              </div>
              <p className={styled.commandDescription}>
                Check if Pixelbar is currently open or closed, with how long it's been that way.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/events</code>
                <span className={styled.tier}>Guest</span>
              </div>
              <p className={styled.commandDescription}>
                View upcoming events from Discord's scheduled events. Shows what's on now and the next events.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/info [topic]</code>
                <span className={styled.tier}>Guest</span>
              </div>
              <p className={styled.commandDescription}>
                Get information about Pixelbar topics. Without a topic, lists all available topics.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/feedback</code>
                <span className={styled.tier}>Guest</span>
              </div>
              <p className={styled.commandDescription}>
                Send feedback to the maintainers. Messages go to Sentry with your name and ID.
              </p>
            </div>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Member Commands</h2>
          
          <div className={styled.commandList}>
            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/closing-time</code>
                <span className={styled.tierMember}>Member</span>
              </div>
              <p className={styled.commandDescription}>
                Post the closing-time reminder to the configured channel. Also posted automatically when the space closes.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/schedule message</code>
                <span className={styled.tierMember}>Member</span>
                <span className={styled.capability}>schedule-posts</span>
              </div>
              <p className={styled.commandDescription}>
                Schedule a message to be posted at a specific time, once or recurring.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/schedule poll</code>
                <span className={styled.tierMember}>Member</span>
                <span className={styled.capability}>schedule-posts</span>
              </div>
              <p className={styled.commandDescription}>
                Schedule a Discord poll with custom duration and multiple choice options.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/schedule list</code>
                <span className={styled.tierMember}>Member</span>
                <span className={styled.capability}>schedule-posts</span>
              </div>
              <p className={styled.commandDescription}>
                View all your scheduled posts with their next occurrence times.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/schedule edit</code>
                <span className={styled.tierMember}>Member</span>
                <span className={styled.capability}>schedule-posts</span>
              </div>
              <p className={styled.commandDescription}>
                Edit an existing scheduled post (time, recurrence, or content).
              </p>
            </div>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Home Assistant Commands</h2>
          
          <div className={styled.note}>
            These commands require Home Assistant to be configured. Minimum tier is <strong>friend</strong>,
            with additional capability requirements for controlling devices.
          </div>
          
          <div className={styled.commandList}>
            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/ha list</code>
                <span className={styled.tierFriend}>Friend+</span>
              </div>
              <p className={styled.commandDescription}>
                List all Home Assistant devices you may see, grouped by kind, with their current state.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/ha status device:</code>
                <span className={styled.tierFriend}>Friend+</span>
              </div>
              <p className={styled.commandDescription}>
                Get detailed status of a specific device. Device option autocompletes with what you can see.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/ha set device: state:</code>
                <span className={styled.tierFriend}>Friend+</span>
                <span className={styled.capability}>ha-lights/switches/admin</span>
              </div>
              <p className={styled.commandDescription}>
                Change a device state (on/off for lights/switches, lock/unlock for doors). Requires capability for the device kind.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/ha open door:</code>
                <span className={styled.tierMember}>Member</span>
                <span className={styled.capability}>ha-doors or ha-admin</span>
              </div>
              <p className={styled.commandDescription}>
                Unlock a door. Doors are member-only and never unlatch.
              </p>
            </div>
          </div>

          <div className={styled.warning}>
            <strong>🔐 Security:</strong>
            <ul>
              <li>Every action is logged with who did it</li>
              <li>Doors can be switched off for everyone with <code>/admin doors off</code></li>
              <li>Unknown devices and permission denials get the same generic response</li>
            </ul>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Admin Commands</h2>
          
          <div className={styled.commandList}>
            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/admin status</code>
                <span className={styled.tierAdmin}>Admin</span>
              </div>
              <p className={styled.commandDescription}>
                View system status: version, uptime, access list counts, Home Assistant connection, and more.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/admin reload</code>
                <span className={styled.tierAdmin}>Admin</span>
              </div>
              <p className={styled.commandDescription}>
                Reload configuration files after hand edits. Keeps old data if files are now invalid.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/admin level set user: level: [reason:]</code>
                <span className={styled.tierAdmin}>Admin</span>
              </div>
              <p className={styled.commandDescription}>
                Set someone's tier to member, friend, or guest. Changes are audited.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/admin level get user:</code>
                <span className={styled.tierAdmin}>Admin</span>
              </div>
              <p className={styled.commandDescription}>
                Check a user's tier, capabilities, and Discord role sync status.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/admin capabilities grant user: capability: [reason:]</code>
                <span className={styled.tierAdmin}>Admin</span>
              </div>
              <p className={styled.commandDescription}>
                Grant a capability to someone. The person is DMed when it actually changes.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/admin capabilities revoke user: capability: [reason:]</code>
                <span className={styled.tierAdmin}>Admin</span>
              </div>
              <p className={styled.commandDescription}>
                Revoke a capability from someone. They are DMed when it actually changes.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/admin sync [user:]</code>
                <span className={styled.tierAdmin}>Admin</span>
              </div>
              <p className={styled.commandDescription}>
                Sync Discord roles from Pixel's data. For one person or everyone in Pixel's lists.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/admin doors off|on</code>
                <span className={styled.tierAdmin}>Admin</span>
              </div>
              <p className={styled.commandDescription}>
                Emergency switch to disable/enable all door control from Pixel at once.
              </p>
            </div>

            <div className={styled.commandItem}>
              <div className={styled.commandHeader}>
                <code className={styled.commandName}>/admin closing-time set</code>
                <span className={styled.tierAdmin}>Admin</span>
              </div>
              <p className={styled.commandDescription}>
                Set the closing-time reminder text. Opens a modal for multi-line input.
              </p>
            </div>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Scheduled Posts</h2>
          <p>
            Schedule messages and polls to be posted automatically:
          </p>

          <h3 className={styled.subheading}>When Format</h3>
          <p>Natural time formats are supported:</p>
          <ul className={styled.list}>
            <li><code>wed 19:00</code> - Next Wednesday at 7 PM</li>
            <li><code>1900</code> or <code>19u</code> - Today at 7 PM (Dutch format supported)</li>
            <li><code>14 oct 19:00</code> - October 14th at 7 PM</li>
            <li><code>tomorrow 9am</code> - Tomorrow at 9 AM</li>
          </ul>

          <h3 className={styled.subheading}>Repeat Options</h3>
          <ul className={styled.list}>
            <li><strong>once</strong> - Post once and remove</li>
            <li><strong>weekly</strong> - Every week on the same day(s)</li>
            <li><strong>fortnightly</strong> - Every two weeks</li>
            <li><strong>monthly</strong> - Same day of month</li>
          </ul>

          <h3 className={styled.subheading}>Template Tokens</h3>
          <p>Use tokens in your scheduled content:</p>
          <ul className={styled.list}>
            <li><code>{`{{date}}`}</code> - Full date</li>
            <li><code>{`{{date+2}}`}</code> - Date plus 2 days</li>
            <li><code>{`{{day}}`}</code> - Day of week</li>
            <li><code>{`{{month}}`}</code> - Month name</li>
            <li><code>{`{{year}}`}</code> - Year</li>
          </ul>
        </section>

        <div className={styled.navigation}>
          <a href="/interact" className={styled.nextButton}>
            Next: How to Interact →
          </a>
        </div>
      </div>
    </div>
  )
}
