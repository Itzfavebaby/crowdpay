import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import MiniLineChart from './MiniLineChart';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key }),
}));

// jsdom has no layout, so ResponsiveContainer measures 0x0 and renders nothing.
// Give it a fixed size so the underlying SVG chart is drawn.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ResponsiveContainer: ({ children, height }) =>
      React.cloneElement(children, { width: 400, height }),
  };
});

const series = [
  { day: '2026-01-01', total_amount: 10 },
  { day: '2026-01-02', total_amount: 25 },
  { day: '2026-01-03', total_amount: 40 },
];

describe('MiniLineChart', () => {
  describe('empty datasets', () => {
    it.each([
      ['an empty array', []],
      ['undefined', undefined],
      ['null', null],
    ])('shows the empty-state message for %s', (_name, data) => {
      const { container } = render(<MiniLineChart data={data} />);
      expect(screen.getByText('dashboard.noContributionData')).toBeInTheDocument();
      expect(container.querySelector('svg')).not.toBeInTheDocument();
    });
  });

  describe('single-point dataset', () => {
    it('renders a chart instead of the empty state', () => {
      const { container } = render(
        <MiniLineChart data={[{ day: '2026-01-01', total_amount: 5 }]} />
      );
      expect(screen.queryByText('dashboard.noContributionData')).not.toBeInTheDocument();
      expect(container.querySelector('svg.recharts-surface')).toBeInTheDocument();
    });

    it('does not throw for a single zero value', () => {
      expect(() =>
        render(<MiniLineChart data={[{ day: '2026-01-01', total_amount: 0 }]} />)
      ).not.toThrow();
    });
  });

  describe('multi-point dataset', () => {
    it('renders the line, grid and axes', () => {
      const { container } = render(<MiniLineChart data={series} />);
      expect(container.querySelector('.recharts-line')).toBeInTheDocument();
      expect(container.querySelector('.recharts-cartesian-grid')).toBeInTheDocument();
      expect(container.querySelector('.recharts-xAxis')).toBeInTheDocument();
      expect(container.querySelector('.recharts-yAxis')).toBeInTheDocument();
    });

    it('formats x-axis ticks as MM-DD', () => {
      render(<MiniLineChart data={series} />);
      expect(screen.getByText('01-01')).toBeInTheDocument();
      expect(screen.getByText('01-03')).toBeInTheDocument();
    });

    it('plots a custom dataKey', () => {
      const data = [
        { day: '2026-02-01', pledged: 3 },
        { day: '2026-02-02', pledged: 9 },
      ];
      const { container } = render(<MiniLineChart data={data} dataKey="pledged" />);
      expect(container.querySelector('.recharts-line-curve')).toBeInTheDocument();
    });

    it('handles all-zero data', () => {
      const data = [
        { day: '2026-01-01', total_amount: 0 },
        { day: '2026-01-02', total_amount: 0 },
      ];
      const { container } = render(<MiniLineChart data={data} />);
      expect(container.querySelector('.recharts-line')).toBeInTheDocument();
    });
  });

  describe('SVG attributes', () => {
    it('renders an svg sized to the 180px container height', () => {
      const { container } = render(<MiniLineChart data={series} />);
      const svg = container.querySelector('svg.recharts-surface');
      expect(svg).toHaveAttribute('height', '180');
      expect(svg).toHaveAttribute('viewBox', '0 0 400 180');
    });

    it('uses theme colour variables for the line and grid', () => {
      const { container } = render(<MiniLineChart data={series} />);
      expect(container.querySelector('.recharts-line-curve')).toHaveAttribute(
        'stroke',
        'var(--color-accent)'
      );
      expect(container.querySelector('.recharts-cartesian-grid line')).toHaveAttribute(
        'stroke',
        'var(--color-border)'
      );
    });

    // The chart does not set role/aria-label or enable recharts' accessibilityLayer,
    // so the svg has no accessible name of its own. Pin the current behaviour.
    it('does not currently expose role or aria-label on the svg', () => {
      const { container } = render(<MiniLineChart data={series} label="Raised" />);
      const svg = container.querySelector('svg.recharts-surface');
      expect(svg).not.toHaveAttribute('aria-label');
      expect(svg).not.toHaveAttribute('role');
    });
  });
});
