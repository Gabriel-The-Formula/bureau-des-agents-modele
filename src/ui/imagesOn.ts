// Les pages de l'étage se montent en avance, hors écran : leurs images n'y sont demandées qu'une fois la page
// vue, sinon l'accueil télécharge toutes les captures de l'Avancement et des Rapports sans les montrer.
import { createContext } from 'react';

export const ImagesOn = createContext(true);
