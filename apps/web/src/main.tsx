import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  return <main><span className="wordmark">Jevellan</span><h1>Autonomous development,<br/>coordinated.</h1><p>The conversation workspace is being built.</p><span className="status">Development preview · phase 0</span></main>;
}

createRoot(document.getElementById('root')!).render(<App />);
