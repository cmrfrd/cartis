import { Component } from '@expressive/react';

export class AppShell extends Component {
  render() {
    return (
      <div className="flex h-screen items-center justify-center bg-surface font-body text-ink">
        <h1 className="font-display text-3xl tracking-widest text-accent">CARTIS</h1>
      </div>
    );
  }
}
