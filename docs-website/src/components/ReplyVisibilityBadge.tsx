import type { ReplyVisibility } from '../types/commands';

interface ReplyVisibilityBadgeProps {
  visibility: ReplyVisibility;
}

const VISIBILITY_CONFIG = {
  public: {
    label: 'Public',
    color: '#3B82F6',
    bgColor: 'rgba(59, 130, 246, 0.15)',
    borderColor: 'rgba(59, 130, 246, 0.3)',
    tooltip: 'Public replies are shown to everyone in the channel and show that you used the command',
  },
  private: {
    label: 'Private',
    color: '#8B5CF6',
    bgColor: 'rgba(139, 92, 246, 0.15)',
    borderColor: 'rgba(139, 92, 246, 0.3)',
    tooltip: 'Private means no one but you sees the reply',
  },
};

export function ReplyVisibilityBadge({ visibility }: ReplyVisibilityBadgeProps) {
  const config = VISIBILITY_CONFIG[visibility];

  return (
    <span
      title={config.tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '4px 10px',
        fontSize: '0.75rem',
        fontWeight: 600,
        color: config.color,
        background: config.bgColor,
        border: `1px solid ${config.borderColor}`,
        borderRadius: '12px',
        cursor: 'help',
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = config.color;
        e.currentTarget.style.color = '#FFFFFF';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = config.bgColor;
        e.currentTarget.style.color = config.color;
      }}
    >
      <span style={{ marginRight: '4px', fontSize: '0.875rem' }}>
        {visibility === 'public' ? '👁️' : '🔒'}
      </span>
      {config.label}
    </span>
  );
}
