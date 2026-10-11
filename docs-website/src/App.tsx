import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import { Navigation } from './components/Navigation'
import { Footer } from './components/Footer'
import { Home } from './pages/Home'
import { Installation } from './pages/Installation'
import { Setup } from './pages/Setup'
import { Usage } from './pages/Usage'
import { Interact } from './pages/Interact'
import './styles/global.css'

export function App() {
  return (
    <Router>
      <Navigation />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/installation" element={<Installation />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/interact" element={<Interact />} />
        </Routes>
      </main>
      <Footer />
    </Router>
  )
}
