import { Routes, Route } from 'react-router-dom';
import Clinician from './views/Clinician';
import DistanceDisplay from './views/DistanceDisplay';
import NearDisplay from './views/NearDisplay';
import Controller from './views/Controller';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Clinician />} />
      <Route path="/distance/:sessionId" element={<DistanceDisplay />} />
      <Route path="/near/:sessionId" element={<NearDisplay />} />
      <Route path="/controller/:sessionId" element={<Controller />} />
    </Routes>
  );
}
