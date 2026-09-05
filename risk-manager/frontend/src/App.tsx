import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom';
import Overview from './pages/Overview';
import FraudMonitor from './pages/FraudMonitor';
import ReturnRisk from './pages/ReturnRisk';
import AbuseRings from './pages/AbuseRings';
import Chargebacks from './pages/Chargebacks';
import Decisions from './pages/Decisions';
import AuditLog from './pages/AuditLog';
import Evaluation from './pages/Evaluation';
import DemoMode from './pages/DemoMode';

const navItems = [
  { path: '/', label: 'Overview' },
  { path: '/fraud', label: 'Fraud Monitor' },
  { path: '/return-risk', label: 'Return Risk' },
  { path: '/abuse-rings', label: 'Abuse Rings' },
  { path: '/chargebacks', label: 'Chargebacks' },
  { path: '/decisions', label: 'AI Decisions' },
  { path: '/audit', label: 'Audit Log' },
  { path: '/evaluation', label: 'Evaluation' },
  { path: '/demo', label: 'Demo Mode' },
];

function App() {
  return (
    <Router>
      <div className="min-h-screen bg-gray-50">
        <nav className="bg-brand-900 text-white shadow-lg">
          <div className="max-w-7xl mx-auto px-4">
            <div className="flex items-center justify-between h-16">
              <div className="flex items-center space-x-4">
                <span className="text-xl font-bold">Risk Manager</span>
                <span className="text-xs bg-accent px-2 py-1 rounded">DEMO MODE</span>
              </div>
              <div className="flex space-x-1">
                {navItems.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    className={({ isActive }) =>
                      `px-3 py-2 rounded text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-white/20 text-white'
                          : 'text-white/70 hover:text-white hover:bg-white/10'
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </div>
          </div>
        </nav>

        <main className="max-w-7xl mx-auto px-4 py-8">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/fraud" element={<FraudMonitor />} />
            <Route path="/return-risk" element={<ReturnRisk />} />
            <Route path="/abuse-rings" element={<AbuseRings />} />
            <Route path="/chargebacks" element={<Chargebacks />} />
            <Route path="/decisions" element={<Decisions />} />
            <Route path="/audit" element={<AuditLog />} />
            <Route path="/evaluation" element={<Evaluation />} />
            <Route path="/demo" element={<DemoMode />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
