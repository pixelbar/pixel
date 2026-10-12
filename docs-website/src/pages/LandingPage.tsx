import { Link } from 'react-router-dom';
import { AnimatedLogo } from '../components/AnimatedLogo';

export function LandingPage() {
  return (
    <div style={{ 
      position: 'relative', 
      width: '100%', 
      height: '100vh',
      overflow: 'hidden',
      background: '#000000'
    }}>
      <AnimatedLogo />
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        textAlign: 'center',
        zIndex: 10,
      }}>
        <h1 style={{
          fontSize: 'clamp(3rem, 10vw, 8rem)',
          fontWeight: 900,
          color: 'transparent',
          background: 'linear-gradient(135deg, #FF1493, #9370DB, #1E90FF, #00FA9A, #FFD700, #FF6347)',
          backgroundClip: 'text',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          textShadow: '0 0 40px rgba(255, 255, 255, 0.3)',
          marginBottom: '1rem',
          letterSpacing: '0.1em',
          pointerEvents: 'none',
        }}>
          PIXEL
        </h1>
        <p style={{
          fontSize: 'clamp(1rem, 3vw, 1.8rem)',
          color: '#FFFFFF',
          textShadow: '0 0 20px rgba(255, 255, 255, 0.5), 0 0 40px rgba(100, 149, 237, 0.3)',
          letterSpacing: '0.2em',
          fontWeight: 300,
          marginBottom: '3rem',
          pointerEvents: 'none',
        }}>
          Pixelbar Assistant Bot
        </p>
        <Link
          to="/commands"
          style={{
            display: 'inline-block',
            padding: '16px 48px',
            fontSize: 'clamp(1rem, 2vw, 1.25rem)',
            fontWeight: 700,
            color: '#FFFFFF',
            background: 'linear-gradient(135deg, #9370DB, #1E90FF)',
            border: '2px solid rgba(255, 255, 255, 0.3)',
            borderRadius: '12px',
            textDecoration: 'none',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            boxShadow: '0 0 30px rgba(147, 112, 219, 0.5), 0 0 60px rgba(30, 144, 255, 0.3)',
            transition: 'all 0.3s ease',
            cursor: 'pointer',
            pointerEvents: 'auto',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.05)';
            e.currentTarget.style.boxShadow = '0 0 40px rgba(147, 112, 219, 0.7), 0 0 80px rgba(30, 144, 255, 0.5)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
            e.currentTarget.style.boxShadow = '0 0 30px rgba(147, 112, 219, 0.5), 0 0 60px rgba(30, 144, 255, 0.3)';
          }}
        >
          View Commands
        </Link>
      </div>
    </div>
  );
}
