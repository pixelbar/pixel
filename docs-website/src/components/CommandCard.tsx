import type { CommandDefinition } from '../types/commands';
import { CopyButton } from './CopyButton';
import { ReplyVisibilityBadge } from './ReplyVisibilityBadge';
import { CapabilityBadge } from './CapabilityBadge';

interface CommandCardProps {
  command: CommandDefinition;
}

export function CommandCard({ command }: CommandCardProps) {
  const renderCommandHeader = (name: string, description: string, isSubcommand = false) => (
    <div style={{ marginBottom: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
        <code
          style={{
            fontSize: isSubcommand ? '1rem' : '1.25rem',
            fontWeight: 700,
            color: '#60A5FA',
            fontFamily: 'monospace',
            background: 'rgba(96, 165, 250, 0.1)',
            padding: '4px 8px',
            borderRadius: '6px',
            border: '1px solid rgba(96, 165, 250, 0.3)',
          }}
        >
          /{name}
        </code>
        <CopyButton text={`/${name}`} />
      </div>
      <p style={{ margin: 0, color: '#D1D5DB', lineHeight: 1.6 }}>{description}</p>
    </div>
  );

  const renderOptions = (options?: typeof command.options) => {
    if (!options || options.length === 0) return null;

    return (
      <div style={{ marginTop: '16px', paddingLeft: '16px', borderLeft: '2px solid rgba(255, 255, 255, 0.1)' }}>
        <h4 style={{ fontSize: '0.875rem', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px' }}>
          Options
        </h4>
        {options.map((option) => (
          <div key={option.name} style={{ marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' }}>
              <code style={{
                fontSize: '0.875rem',
                color: '#34D399',
                fontFamily: 'monospace',
                background: 'rgba(52, 211, 153, 0.1)',
                padding: '2px 6px',
                borderRadius: '4px',
              }}>
                {option.name}
              </code>
              {option.required && (
                <span style={{
                  fontSize: '0.7rem',
                  color: '#F87171',
                  fontWeight: 600,
                  background: 'rgba(248, 113, 113, 0.15)',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  border: '1px solid rgba(248, 113, 113, 0.3)',
                }}>
                  REQUIRED
                </span>
              )}
              {option.autocomplete && (
                <span style={{
                  fontSize: '0.7rem',
                  color: '#A78BFA',
                  fontWeight: 500,
                  background: 'rgba(167, 139, 250, 0.1)',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  border: '1px solid rgba(167, 139, 250, 0.2)',
                }}>
                  autocomplete
                </span>
              )}
              {option.form && (
                <span style={{
                  fontSize: '0.7rem',
                  color: '#FBBF24',
                  fontWeight: 500,
                  background: 'rgba(251, 191, 36, 0.1)',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  border: '1px solid rgba(251, 191, 36, 0.2)',
                }}>
                  form
                </span>
              )}
            </div>
            <p style={{ margin: 0, fontSize: '0.875rem', color: '#9CA3AF' }}>{option.description}</p>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div
      style={{
        background: 'rgba(255, 255, 255, 0.03)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: '12px',
        padding: '24px',
        marginBottom: '24px',
        transition: 'all 0.3s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
        e.currentTarget.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.2)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)';
        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      {renderCommandHeader(command.name, command.description)}
      
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <ReplyVisibilityBadge visibility={command.replyVisibility} />
        {command.capability && <CapabilityBadge capability={command.capability} />}
      </div>

      {renderOptions(command.options)}

      {command.subcommands && command.subcommands.length > 0 && (
        <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
          <h4 style={{
            fontSize: '0.875rem',
            color: '#9CA3AF',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: '16px',
          }}>
            Subcommands
          </h4>
          {command.subcommands.map((sub) => (
            <div
              key={sub.name}
              style={{
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '16px',
              }}
            >
              {renderCommandHeader(`${command.name} ${sub.name}`, sub.description, true)}
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                {sub.replyVisibility && <ReplyVisibilityBadge visibility={sub.replyVisibility} />}
                {sub.capability && <CapabilityBadge capability={sub.capability} />}
              </div>

              {renderOptions(sub.options)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
