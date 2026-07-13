import React, { useState } from 'react';
import { setToken } from '../api';

interface Props {
  onLogin: () => void;
}

export default function LoginPage({ onLogin }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Email and password are required');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json() as { token?: string; error?: string };
      if (!res.ok || !data.token) {
        setError(data.error || 'Invalid credentials');
        setLoading(false);
        return;
      }
      setToken(data.token);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Logo / title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-600 mb-4">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-white">Koda Memory</h1>
          <p className="text-gray-400 mt-2">Admin Dashboard</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-gray-800 rounded-xl shadow-2xl p-8 space-y-5 border border-gray-700"
        >
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-2">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="admin@sifututor.my"
              autoComplete="email"
              autoFocus
              className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-gray-100
                         placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-1
                         focus:ring-indigo-500 transition"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-2">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-gray-100
                         placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-1
                         focus:ring-indigo-500 transition"
            />
          </div>

          {error && (
            <div className="bg-red-900/40 border border-red-700 text-red-300 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800
                       disabled:cursor-not-allowed text-white font-medium rounded-lg transition
                       focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2
                       focus:ring-offset-gray-800"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Signing in...
              </span>
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        <p className="text-center text-gray-600 text-xs mt-6">
          Koda Memory v1 — Self-hosted MCP Server
        </p>
      </div>
    </div>
  );
}
