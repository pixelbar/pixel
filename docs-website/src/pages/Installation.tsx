import styled from './Documentation.module.css'

export function Installation() {
  return (
    <div className={styled.container}>
      <div className={styled.content}>
        <h1 className={styled.pageTitle}>Installation</h1>
        <p className={styled.lead}>
          Get Pixel up and running on your local machine or deploy it to Azure.
        </p>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Prerequisites</h2>
          <div className={styled.card}>
            <ul className={styled.list}>
              <li>
                <strong>Node.js</strong> - LTS version (check <code>.nvmrc</code>)
              </li>
              <li>
                <strong>pnpm</strong> - Enable with <code>corepack enable</code>
              </li>
              <li>
                <strong>just</strong> - Task runner (<a href="https://just.systems/man/en/packages.html" target="_blank" rel="noopener noreferrer" className={styled.link}>Installation guide</a>)
              </li>
              <li>
                <strong>Discord Bot Token</strong> - From the Discord Developer Portal
              </li>
            </ul>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Quick Start</h2>
          
          <div className={styled.step}>
            <h3 className={styled.stepTitle}>1. Clone the Repository</h3>
            <pre className={styled.codeBlock}>
              <code>{`git clone https://github.com/pixelbar/pixel.git
cd pixel`}</code>
            </pre>
          </div>

          <div className={styled.step}>
            <h3 className={styled.stepTitle}>2. Install Dependencies</h3>
            <pre className={styled.codeBlock}>
              <code>pnpm install</code>
            </pre>
          </div>

          <div className={styled.step}>
            <h3 className={styled.stepTitle}>3. Configure Environment</h3>
            <pre className={styled.codeBlock}>
              <code>{`cp .env.example .env
cp config/admins.example.yaml config/admins.yaml
cp config/members.example.yaml config/members.yaml`}</code>
            </pre>
            <div className={styled.note}>
              <strong>⚠️ Important:</strong> Edit <code>.env</code> and fill in your Discord bot token and other required values.
            </div>
          </div>

          <div className={styled.step}>
            <h3 className={styled.stepTitle}>4. Validate Configuration</h3>
            <pre className={styled.codeBlock}>
              <code>just validate-config</code>
            </pre>
          </div>

          <div className={styled.step}>
            <h3 className={styled.stepTitle}>5. Register Commands</h3>
            <pre className={styled.codeBlock}>
              <code>just register</code>
            </pre>
            <p className={styled.stepDescription}>
              This registers slash commands with your Discord test guild.
            </p>
          </div>

          <div className={styled.step}>
            <h3 className={styled.stepTitle}>6. Run Pixel</h3>
            <pre className={styled.codeBlock}>
              <code>just dev</code>
            </pre>
            <p className={styled.stepDescription}>
              Pixel will start with hot reload enabled. Any code changes will automatically restart the bot.
            </p>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Setting Up Your Discord Bot</h2>
          <div className={styled.card}>
            <ol className={styled.numberedList}>
              <li>
                Create an application at{' '}
                <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer" className={styled.link}>
                  discord.com/developers/applications
                </a>
              </li>
              <li>
                Under <strong>Bot</strong>, reset the token and put it in <code>DISCORD_TOKEN</code>
              </li>
              <li>
                Copy the application ID and put it in <code>DISCORD_APP_ID</code>
              </li>
              <li>
                Create a test server, invite the bot with the <code>bot</code> and{' '}
                <code>applications.commands</code> scopes
              </li>
              <li>
                Copy the server ID and put it in <code>DISCORD_GUILD_ID</code>
              </li>
              <li>
                Enable Developer Mode in Discord, right-click yourself, choose{' '}
                <strong>Copy User ID</strong>, and add yourself to{' '}
                <code>config/admins.yaml</code> and <code>config/members.yaml</code>
              </li>
            </ol>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Common Commands</h2>
          <div className={styled.commandGrid}>
            <div className={styled.commandCard}>
              <code className={styled.command}>just dev</code>
              <p className={styled.commandDesc}>Run locally with hot reload</p>
            </div>
            <div className={styled.commandCard}>
              <code className={styled.command}>just check</code>
              <p className={styled.commandDesc}>Lint, type-check, test with coverage</p>
            </div>
            <div className={styled.commandCard}>
              <code className={styled.command}>just test</code>
              <p className={styled.commandDesc}>Run tests only</p>
            </div>
            <div className={styled.commandCard}>
              <code className={styled.command}>just fmt</code>
              <p className={styled.commandDesc}>Auto-format code</p>
            </div>
            <div className={styled.commandCard}>
              <code className={styled.command}>just build</code>
              <p className={styled.commandDesc}>Compile to dist/</p>
            </div>
            <div className={styled.commandCard}>
              <code className={styled.command}>just register</code>
              <p className={styled.commandDesc}>Register slash commands</p>
            </div>
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Docker Build</h2>
          <p>Build the container image:</p>
          <pre className={styled.codeBlock}>
            <code>just docker-build</code>
          </pre>
          <div className={styled.note}>
            Images are published to <code>ghcr.io/pixelbar/pixel</code> on merges to main.
          </div>
        </section>

        <section className={styled.section}>
          <h2 className={styled.sectionHeading}>Troubleshooting</h2>
          <div className={styled.card}>
            <h3 className={styled.subheading}>Bot won't start?</h3>
            <ul className={styled.list}>
              <li>Check that your <code>.env</code> file has all required values</li>
              <li>Ensure Discord IDs in config files are quoted strings</li>
              <li>Run <code>just validate-config</code> to check for errors</li>
              <li>Make sure another instance isn't running on the same token</li>
            </ul>

            <h3 className={styled.subheading}>Commands not showing in Discord?</h3>
            <ul className={styled.list}>
              <li>Run <code>just register</code> to register commands</li>
              <li>Wait a few seconds for Discord to sync</li>
              <li>Check that your bot is in the correct guild</li>
            </ul>
          </div>
        </section>

        <div className={styled.navigation}>
          <a href="/setup" className={styled.nextButton}>
            Next: Setup and Configuration →
          </a>
        </div>
      </div>
    </div>
  )
}
