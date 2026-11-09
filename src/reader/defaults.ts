import type { ReaderSettings } from '../types';

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontFamily: 'serif',
  fontSize: 20,
  lineHeight: 1.9,
  paragraphSpacing: 16,
  margin: 32,
  width: 760,
  theme: 'paper',
  mode: 'scroll',
  encoding: 'auto',
  keepAwake: false,
  wheelThreshold: 100,
};

export const READER_THEME_COLORS = {
  paper: {
    background: '#eeeae2',
    surface: '#fbfaf6',
    text: '#27231f',
    secondary: '#6d665d',
    border: 'rgba(53, 45, 37, 0.13)',
  },
  sepia: {
    background: '#ddd0b4',
    surface: '#f4e7c9',
    text: '#3d3020',
    secondary: '#78664c',
    border: 'rgba(84, 65, 39, 0.18)',
  },
  dark: {
    background: '#161719',
    surface: '#222326',
    text: '#e8e4dc',
    secondary: '#aaa59b',
    border: 'rgba(255, 255, 255, 0.12)',
  },
} as const;

export const ANNOTATION_COLORS = ['#f4c542', '#65c58d', '#79a7ff', '#ef8fab', '#c99af2'] as const;

