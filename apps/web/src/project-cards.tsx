import { createContext } from 'react';
import type { ProjectWorkCard } from '@jevellan/core/client';

/** Engine snapshots shared by Overview and chat; keys only identify the displayed resource. */
export const ProjectCardsContext = createContext<ReadonlyMap<string, ProjectWorkCard>>(new Map());
export const projectCardKey = (kind: ProjectWorkCard['kind'], id: string) => `${kind}:${id}`;
