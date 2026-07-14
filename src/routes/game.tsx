import { createFileRoute } from '@tanstack/react-router';
import { GameCanvas } from '@/components/game/GameCanvas';

export const Route = createFileRoute('/game')({
  component: GameRoute,
  head: () => ({
    meta: [
      { title: 'CS 2 Mobile - Oyun' },
      { name: 'description', content: 'CS 2 Mobile: 3D FPS oynanış ekranı.' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover' },
    ],
  }),
});

function GameRoute() {
  return <GameCanvas />;
}
