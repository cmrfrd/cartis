import { Component } from '@expressive/react';
import { EmptyState } from '../ui';
import type { CompiledCard } from './compile';

/** Renders user-compiled cards behind expressive's built-in error boundary. */
export class Sandbox extends Component {
  card?: CompiledCard = undefined;

  async catch(error: Error) {
    this.fallback = (
      <div className="max-w-[375px] rounded-lg border border-red-900 bg-red-950/60 p-4 text-sm text-red-200">
        <p className="font-semibold">Card crashed while rendering</p>
        <pre className="mt-2 whitespace-pre-wrap text-xs">{String(error)}</pre>
      </div>
    );
    // Stay in fallback until a new compile hands us a different card, then retry.
    await new Promise<void>((resolve) => {
      const stop = this.set('card', () => {
        stop();
        resolve();
      });
    });
  }

  render() {
    const { card: UserCard } = this;
    if (!UserCard) {
      return (
        <EmptyState
          message="Nothing compiled yet."
          hint="Fix the code on the left to see a card."
        />
      );
    }
    return <UserCard />;
  }
}
