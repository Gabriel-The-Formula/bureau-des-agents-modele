// La vue d'une salle : la barre du haut, le bureau en pixel art (avec le panneau de l'équipe à droite, ou dessous
// sur une tablette en hauteur) et Max en bas. Chargée à part de l'étage , avec le moteur du jeu.
import { useOffice } from '../state/store.ts';
import { AskBar, Dialog } from './Dialog.tsx';
import { Office } from './Office.tsx';
import { Panel } from './Panel.tsx';
import { RoomStrip, TopBar } from './TopBar.tsx';

export { camera, world } from '../engine/instance.ts';
export { party } from './interact.ts';
export { perf } from './Office.tsx';
export { Rooms } from './Rooms.tsx';

export function RoomView() {
  const filming = useOffice((s) => s.filming);
  const room = useOffice((s) => s.room);
  return (
    <div className="frame view-in" key={room ?? 'replay'}>
      <TopBar />
      {!filming && <RoomStrip />}
      <div className="main">
        <div className="stage">
          <Office />
          <AskBar />
        </div>
        {!filming && <Panel />}
      </div>
      <Dialog />
    </div>
  );
}
