import { Link } from 'react-router-dom'
import styled from './Home.module.css'

export function Home() {
  return (
    <div className={styled.container}>
      {/* Hero Section */}
      <section className={styled.hero}>
        <div className={styled.heroContent}>
          <div className={styled.pixelGrid}>
            <div className={styled.pixel} style={{ backgroundColor: '#0080ff' }} />
            <div className={styled.pixel} style={{ backgroundColor: '#a855f7' }} />
            <div className={styled.pixel} style={{ backgroundColor: '#ec4899' }} />
            <div className={styled.pixel} style={{ backgroundColor: '#f97316' }} />
            <div className={styled.pixel} style={{ backgroundColor: '#fbbf24' }} />
            <div className={styled.pixel} style={{ backgroundColor: '#10b981' }} />
          </div>
          <h1 className={styled.title}>
            Welcome to <span className={styled.highlight}>Pixel</span>
          </h1>
          <p className={styled.subtitle}>
            The helpful assistant bot for the Pixelbar hackerspace in Rotterdam
          </p>
          <div className={styled.ctaButtons}>
            <Link to="/installation" className={styled.primaryButton}>
              Get Started
            </Link>
            <a
              href="https://github.com/pixelbar/pixel"
              target="_blank"
              rel="noopener noreferrer"
              className={styled.secondaryButton}
            >
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className={styled.features}>
        <h2 className={styled.sectionTitle}>What can Pixel do?</h2>
        <div className={styled.featureGrid}>
          <div className={styled.featureCard}>
            <div className={styled.featureIcon} style={{ background: 'linear-gradient(135deg, #0080ff, #00b4ff)' }}>
              🏠
            </div>
            <h3 className={styled.featureTitle}>Space Status</h3>
            <p className={styled.featureDescription}>
              Check if Pixelbar is open, see upcoming events, and get announcements when the space opens or closes.
            </p>
          </div>

          <div className={styled.featureCard}>
            <div className={styled.featureIcon} style={{ background: 'linear-gradient(135deg, #a855f7, #c084fc)' }}>
              🔐
            </div>
            <h3 className={styled.featureTitle}>Smart Access Control</h3>
            <p className={styled.featureDescription}>
              Tier-based permissions system (guest, friend, member, admin) with secure authentication and audit logs.
            </p>
          </div>

          <div className={styled.featureCard}>
            <div className={styled.featureIcon} style={{ background: 'linear-gradient(135deg, #ec4899, #f472b6)' }}>
              🤖
            </div>
            <h3 className={styled.featureTitle}>Home Automation</h3>
            <p className={styled.featureDescription}>
              Control lights, switches, and doors through Home Assistant integration with capability-based permissions.
            </p>
          </div>

          <div className={styled.featureCard}>
            <div className={styled.featureIcon} style={{ background: 'linear-gradient(135deg, #f97316, #fb923c)' }}>
              📅
            </div>
            <h3 className={styled.featureTitle}>Event Management</h3>
            <p className={styled.featureDescription}>
              Schedule messages and polls, view upcoming events, and set recurring announcements for the community.
            </p>
          </div>

          <div className={styled.featureCard}>
            <div className={styled.featureIcon} style={{ background: 'linear-gradient(135deg, #fbbf24, #fcd34d)' }}>
              💬
            </div>
            <h3 className={styled.featureTitle}>Multi-Platform</h3>
            <p className={styled.featureDescription}>
              Discord integration with Mastodon announcements. Platform-agnostic core ready for Telegram and more.
            </p>
          </div>

          <div className={styled.featureCard}>
            <div className={styled.featureIcon} style={{ background: 'linear-gradient(135deg, #10b981, #34d399)' }}>
              📊
            </div>
            <h3 className={styled.featureTitle}>Monitoring & Logging</h3>
            <p className={styled.featureDescription}>
              Integrated Sentry error tracking, structured logging with Pino, and comprehensive audit trails.
            </p>
          </div>
        </div>
      </section>

      {/* Tech Stack Section */}
      <section className={styled.techStack}>
        <h2 className={styled.sectionTitle}>Built with Modern Technology</h2>
        <div className={styled.techGrid}>
          <div className={styled.techCard}>
            <div className={styled.techIcon}>🟦</div>
            <h3>TypeScript</h3>
            <p>Type-safe code with strict mode enabled</p>
          </div>
          <div className={styled.techCard}>
            <div className={styled.techIcon}>🟩</div>
            <h3>Node.js</h3>
            <p>LTS runtime with ESM modules</p>
          </div>
          <div className={styled.techCard}>
            <div className={styled.techIcon}>🟪</div>
            <h3>Discord.js</h3>
            <p>Powerful Discord bot framework</p>
          </div>
          <div className={styled.techCard}>
            <div className={styled.techIcon}>🟧</div>
            <h3>Azure</h3>
            <p>Container Apps hosting with Terraform</p>
          </div>
        </div>
      </section>

      {/* Quick Start Section */}
      <section className={styled.quickStart}>
        <h2 className={styled.sectionTitle}>Quick Start</h2>
        <div className={styled.steps}>
          <div className={styled.step}>
            <div className={styled.stepNumber}>1</div>
            <h3 className={styled.stepTitle}>Install Dependencies</h3>
            <pre className={styled.codeBlock}>
              <code>pnpm install</code>
            </pre>
          </div>
          <div className={styled.step}>
            <div className={styled.stepNumber}>2</div>
            <h3 className={styled.stepTitle}>Configure Environment</h3>
            <pre className={styled.codeBlock}>
              <code>cp .env.example .env{'\n'}# Fill in your Discord token and other settings</code>
            </pre>
          </div>
          <div className={styled.step}>
            <div className={styled.stepNumber}>3</div>
            <h3 className={styled.stepTitle}>Run the Bot</h3>
            <pre className={styled.codeBlock}>
              <code>just dev</code>
            </pre>
          </div>
        </div>
        <Link to="/installation" className={styled.learnMoreButton}>
          View Full Installation Guide →
        </Link>
      </section>
    </div>
  )
}
