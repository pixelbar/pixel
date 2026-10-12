interface CapabilityBadgeProps {
  capability: string;
}

export function CapabilityBadge({ capability }: CapabilityBadgeProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '6px 12px',
        fontSize: '0.75rem',
        fontWeight: 700,
        color: '#F59E0B',
        background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(251, 191, 36, 0.15))',
        border: '1.5px solid rgba(245, 158, 11, 0.4)',
        borderRadius: '8px',
        fontFamily: 'monospace',
        letterSpacing: '0.025em',
        textTransform: 'uppercase',
        boxShadow: '0 0 12px rgba(245, 158, 11, 0.15)',
        transition: 'all 0.2s ease',
      }}
      title={`Requires the '${capability}' capability (granted by admins)`}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'linear-gradient(135deg, rgba(245, 158, 11, 0.25), rgba(251, 191, 36, 0.25))';
        e.currentTarget.style.borderColor = 'rgba(245, 158, 11, 0.6)';
        e.currentTarget.style.boxShadow = '0 0 16px rgba(245, 158, 11, 0.3)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(251, 191, 36, 0.15))';
        e.currentTarget.style.borderColor = 'rgba(245, 158, 11, 0.4)';
        e.currentTarget.style.boxShadow = '0 0 12px rgba(245, 158, 11, 0.15)';
      }}
    >
      <span style={{ marginRight: '6px', fontSize: '0.875rem' }}>⚡</span>
      {capability}
    </span>
  );
}
