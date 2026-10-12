import { Link } from 'react-router-dom';
import { COMMANDS, TIER_INFO } from '../data/commands';
import { CommandCard } from '../components/CommandCard';
import type { AccessTier } from '../types/commands';

export function CommandsPage() {
  const commandsByTier = {
    guest: COMMANDS.filter((cmd) => cmd.tier === 'guest'),
    friend: COMMANDS.filter((cmd) => cmd.tier === 'friend'),
    member: COMMANDS.filter((cmd) => cmd.tier === 'member'),
    admin: COMMANDS.filter((cmd) => cmd.tier === 'admin'),
  };

  const renderTierSection = (tier: AccessTier) => {
    const commands = commandsByTier[tier];
    if (commands.length === 0) return null;

    const info = TIER_INFO[tier];

    return (
      <section key={tier} id={tier} style={{ marginBottom: '60px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            marginBottom: '24px',
            paddingBottom: '16px',
            borderBottom: `3px solid ${info.color}`,
          }}
        >
          <div
            style={{
              width: '8px',
              height: '48px',
              background: `linear-gradient(180deg, ${info.color}, ${info.color}80)`,
              borderRadius: '4px',
              marginRight: '16px',
            }}
          />
          <div>
            <h2
              style={{
                fontSize: '2rem',
                fontWeight: 900,
                margin: 0,
                marginBottom: '4px',
                color: info.color,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {info.label}
            </h2>
            <p style={{ margin: 0, color: '#9CA3AF', fontSize: '1rem' }}>{info.description}</p>
          </div>
        </div>
        
        {commands.map((command) => (
          <CommandCard key={command.name} command={command} />
        ))}
      </section>
    );
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#000000',
        color: '#FFFFFF',
        padding: '40px 20px',
      }}
    >
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: '60px' }}>
          <Link
            to="/"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              marginBottom: '32px',
              color: '#60A5FA',
              textDecoration: 'none',
              fontSize: '1rem',
              fontWeight: 600,
              transition: 'color 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#93C5FD';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#60A5FA';
            }}
          >
            <span style={{ marginRight: '8px', fontSize: '1.25rem' }}>←</span>
            Back to Home
          </Link>

          <h1
            style={{
              fontSize: 'clamp(2.5rem, 6vw, 4rem)',
              fontWeight: 900,
              margin: 0,
              marginBottom: '16px',
              background: 'linear-gradient(135deg, #FF1493, #9370DB, #1E90FF, #00FA9A)',
              backgroundClip: 'text',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '0.02em',
            }}
          >
            Commands
          </h1>
          <p
            style={{
              fontSize: '1.25rem',
              color: '#9CA3AF',
              margin: 0,
              maxWidth: '800px',
              lineHeight: 1.6,
            }}
          >
            All commands available in Pixel, organized by access tier. Commands are available in Discord.
          </p>
        </div>

        {/* Navigation */}
        <nav
          style={{
            background: 'rgba(255, 255, 255, 0.05)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '12px',
            padding: '20px',
            marginBottom: '48px',
            display: 'flex',
            gap: '16px',
            flexWrap: 'wrap',
          }}
        >
          {(['guest', 'friend', 'member', 'admin'] as const).map((tier) => (
            <a
              key={tier}
              href={`#${tier}`}
              style={{
                padding: '12px 20px',
                background: `linear-gradient(135deg, ${TIER_INFO[tier].color}20, ${TIER_INFO[tier].color}10)`,
                border: `2px solid ${TIER_INFO[tier].color}40`,
                borderRadius: '8px',
                color: TIER_INFO[tier].color,
                textDecoration: 'none',
                fontWeight: 700,
                fontSize: '0.875rem',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = `${TIER_INFO[tier].color}30`;
                e.currentTarget.style.borderColor = TIER_INFO[tier].color;
                e.currentTarget.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = `linear-gradient(135deg, ${TIER_INFO[tier].color}20, ${TIER_INFO[tier].color}10)`;
                e.currentTarget.style.borderColor = `${TIER_INFO[tier].color}40`;
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              {TIER_INFO[tier].label}
            </a>
          ))}
        </nav>

        {/* Legend */}
        <div
          style={{
            background: 'rgba(59, 130, 246, 0.05)',
            border: '1px solid rgba(59, 130, 246, 0.2)',
            borderRadius: '12px',
            padding: '24px',
            marginBottom: '48px',
          }}
        >
          <h3
            style={{
              fontSize: '1.25rem',
              fontWeight: 700,
              color: '#60A5FA',
              margin: 0,
              marginBottom: '16px',
            }}
          >
            Legend
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <span style={{ fontSize: '1rem' }}>👁️</span>
                <strong style={{ color: '#3B82F6' }}>Public Reply</strong>
              </div>
              <p style={{ margin: 0, fontSize: '0.875rem', color: '#9CA3AF' }}>
                Everyone in the channel sees the reply and that you used the command
              </p>
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <span style={{ fontSize: '1rem' }}>🔒</span>
                <strong style={{ color: '#8B5CF6' }}>Private Reply</strong>
              </div>
              <p style={{ margin: 0, fontSize: '0.875rem', color: '#9CA3AF' }}>
                Only you see the reply (ephemeral on Discord)
              </p>
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <span style={{ fontSize: '1rem' }}>⚡</span>
                <strong style={{ color: '#F59E0B' }}>Capability</strong>
              </div>
              <p style={{ margin: 0, fontSize: '0.875rem', color: '#9CA3AF' }}>
                Requires a capability granted by admins via <code style={{ color: '#34D399' }}>/admin capabilities</code>
              </p>
            </div>
          </div>
        </div>

        {/* Command Sections */}
        {renderTierSection('guest')}
        {renderTierSection('friend')}
        {renderTierSection('member')}
        {renderTierSection('admin')}

        {/* Footer */}
        <footer
          style={{
            marginTop: '80px',
            paddingTop: '40px',
            borderTop: '1px solid rgba(255, 255, 255, 0.1)',
            textAlign: 'center',
            color: '#6B7280',
          }}
        >
          <p style={{ margin: 0, fontSize: '0.875rem' }}>
            Built for the Pixelbar hackerspace community
          </p>
        </footer>
      </div>
    </div>
  );
}
