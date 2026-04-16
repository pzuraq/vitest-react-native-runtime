import type { Theme } from './theme';
import type { ModuleStatus } from './types';

export function statusIcon(status: ModuleStatus): string {
  switch (status) {
    case 'pass':
      return '✓';
    case 'fail':
      return '✗';
    case 'running':
      return '⋯';
    case 'pending':
      return '○';
    default:
      return '·';
  }
}

export function statusColor(status: ModuleStatus, colors: Theme['colors']): string {
  switch (status) {
    case 'pass':
      return colors.pass;
    case 'fail':
      return colors.fail;
    case 'running':
      return colors.warning;
    default:
      return colors.textDim;
  }
}
