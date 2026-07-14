import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/game')({
  component: GameRoute,
});

function GameRoute() {
  return <GameCanvas />;
}

import { GameCanvas } from '@/components/game/GameCanvas';
