import React, { useState, useEffect } from 'react';
import { getDashboardUsers, createDashboardUser, deleteDashboardUser, changeUserPassword } from '../api';
import type { DashboardUser } from '../types';

export default function UsersPage() {
  const [users, setUsers] = useState<DashboardUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // New user form
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'user'>('user');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Password change modal
  const [changingPasswordFor, setChangingPasswordFor] = useState<DashboardUser | null>(null);
  const [newPwd, setNewPwd] = useState('');
  const [pwdError, setPwdError] = useState('');
  const [pwdSaving, setPwdSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await getDashboardUsers();
      setUsers(data.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newEmail.trim() || !newPassword) {
      setCreateError('Email and password are required');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      await createDashboardUser(newEmail.trim(), newPassword, newRole);
      setNewEmail('');
      setNewPassword('');
      setNewRole('user');
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(user: DashboardUser) {
    if (!confirm(`Delete ${user.email}? This cannot be undone.`)) return;
    try {
      await deleteDashboardUser(user.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    }
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    if (!newPwd || !changingPasswordFor) return;
    setPwdSaving(true);
    setPwdError('');
    try {
      await changeUserPassword(changingPasswordFor.id, newPwd);
      setChangingPasswordFor(null);
      setNewPwd('');
    } catch (err) {
      setPwdError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setPwdSaving(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">User Management</h1>
        <p className="text-gray-400 text-sm mt-1">Manage who can log in to the Koda dashboard.</p>
      </div>

      {/* User list */}
      <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-700">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Users</h2>
        </div>
        {loading ? (
          <div className="px-6 py-8 text-center text-gray-500">Loading...</div>
        ) : error ? (
          <div className="px-6 py-4 text-red-400 text-sm">{error}</div>
        ) : users.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-500">No users yet.</div>
        ) : (
          <ul className="divide-y divide-gray-700">
            {users.map(user => (
              <li key={user.id} className="px-6 py-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-white font-medium truncate">{user.email}</p>
                  <p className="text-gray-400 text-xs mt-0.5">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      user.role === 'admin'
                        ? 'bg-indigo-900/50 text-indigo-300'
                        : 'bg-gray-700 text-gray-300'
                    }`}>{user.role}</span>
                    <span className="ml-2">Created {new Date(user.created_at).toLocaleDateString()}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => { setChangingPasswordFor(user); setNewPwd(''); setPwdError(''); }}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-600 text-gray-300
                               hover:border-indigo-500 hover:text-indigo-300 transition"
                  >
                    Change password
                  </button>
                  <button
                    onClick={() => handleDelete(user)}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-600 text-gray-300
                               hover:border-red-500 hover:text-red-400 transition"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Create user form */}
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-6">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">Add User</h2>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Email</label>
              <input
                type="email"
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                placeholder="user@example.com"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100
                           placeholder-gray-500 text-sm focus:outline-none focus:border-indigo-500 transition"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100
                           placeholder-gray-500 text-sm focus:outline-none focus:border-indigo-500 transition"
              />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Role</label>
              <select
                value={newRole}
                onChange={e => setNewRole(e.target.value as 'admin' | 'user')}
                className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 text-sm
                           focus:outline-none focus:border-indigo-500 transition"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="flex-1" />
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800
                         text-white text-sm font-medium rounded-lg transition self-end"
            >
              {creating ? 'Creating...' : 'Create User'}
            </button>
          </div>
          {createError && (
            <p className="text-red-400 text-sm">{createError}</p>
          )}
        </form>
      </div>

      {/* Change password modal */}
      {changingPasswordFor && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-white font-semibold mb-1">Change Password</h3>
            <p className="text-gray-400 text-sm mb-4">{changingPasswordFor.email}</p>
            <form onSubmit={handlePasswordChange} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">New Password</label>
                <input
                  type="password"
                  value={newPwd}
                  onChange={e => setNewPwd(e.target.value)}
                  placeholder="••••••••"
                  autoFocus
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100
                             placeholder-gray-500 text-sm focus:outline-none focus:border-indigo-500 transition"
                />
              </div>
              {pwdError && <p className="text-red-400 text-sm">{pwdError}</p>}
              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={() => setChangingPasswordFor(null)}
                  className="px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600
                             hover:border-gray-400 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pwdSaving}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800
                             text-white text-sm font-medium rounded-lg transition"
                >
                  {pwdSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
