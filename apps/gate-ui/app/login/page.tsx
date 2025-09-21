'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../components/auth-context';

export default function LoginPage() {
  const { login, user } = useAuth();
  const router = useRouter();
  const [name, setName] = useState(user ?? '');

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) {
      return;
    }
    login(name.trim());
    router.push('/bundles');
  };

  return (
    <div className="login-card">
      <h1>Gate Console Login</h1>
      <p>Enter your name to review and approve bundles.</p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="username">Operator Name</label>
        <input
          id="username"
          name="username"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. alice"
          autoFocus
        />
        <button type="submit">Sign In</button>
      </form>
    </div>
  );
}
