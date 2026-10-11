import { AnimatedLogo } from './components/AnimatedLogo'
import './styles/global.css'

export function App() {
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
        pointerEvents: 'none',
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
        }}>
          PIXEL
        </h1>
        <p style={{
          fontSize: 'clamp(1rem, 3vw, 1.8rem)',
          color: '#FFFFFF',
          textShadow: '0 0 20px rgba(255, 255, 255, 0.5), 0 0 40px rgba(100, 149, 237, 0.3)',
          letterSpacing: '0.2em',
          fontWeight: 300,
        }}>
          Pixelbar Assistant Bot
        </p>
      </div>
    </div>
  )
}
