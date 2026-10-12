import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { LandingPage } from './pages/LandingPage';
import { CommandsPage } from './pages/CommandsPage';
import './styles/global.css';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/commands" element={<CommandsPage />} />
      </Routes>
    </BrowserRouter>
  );
}
