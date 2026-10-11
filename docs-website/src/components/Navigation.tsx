import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import styled from './Navigation.module.css'

const navItems = [
  { path: '/', label: 'Home' },
  { path: '/installation', label: 'Installation' },
  { path: '/setup', label: 'Setup' },
  { path: '/usage', label: 'Usage' },
  { path: '/interact', label: 'Interact' },
]

export function Navigation() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const location = useLocation()

  return (
    <nav className={styled.nav}>
      <div className={styled.container}>
        <Link to="/" className={styled.logo}>
          <span className={styled.logoPixel}>■</span>
          <span className={styled.logoText}>Pixel</span>
        </Link>

        <button
          className={styled.mobileMenuButton}
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label="Toggle menu"
        >
          <span className={mobileMenuOpen ? styled.menuIconOpen : styled.menuIcon}>
            {mobileMenuOpen ? '✕' : '☰'}
          </span>
        </button>

        <ul className={`${styled.navList} ${mobileMenuOpen ? styled.navListOpen : ''}`}>
          {navItems.map(({ path, label }) => (
            <li key={path}>
              <Link
                to={path}
                className={`${styled.navLink} ${location.pathname === path ? styled.navLinkActive : ''}`}
                onClick={() => setMobileMenuOpen(false)}
              >
                {label}
              </Link>
            </li>
          ))}
          <li>
            <a
              href="https://github.com/pixelbar/pixel"
              target="_blank"
              rel="noopener noreferrer"
              className={styled.githubLink}
            >
              GitHub
            </a>
          </li>
        </ul>
      </div>
    </nav>
  )
}
