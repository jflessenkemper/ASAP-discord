import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

// StrictMode disabled — double-mounting causes the loaded GLB scene to be
// mutated/cloned twice, leading to duplicated geometry and renderer hangs.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
