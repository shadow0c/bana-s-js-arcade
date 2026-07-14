import { createFileRoute } from '@tanstack/react-router';
import { GameCanvas } from '@/components/game/GameCanvas';

export const Route = createFileRoute('/game')({
  component: GameRoute,
});

function GameRoute() {
  return <GameCanvas />;
}
