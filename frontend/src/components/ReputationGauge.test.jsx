import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import ReputationGauge from './ReputationGauge';

// The component's scale is 0-1000, so 0, 50 and 100 are low-end boundaries.
function setup(props) {
  const { container } = render(<ReputationGauge {...props} />);
  return {
    container,
    svg: container.querySelector('svg'),
    paths: container.querySelectorAll('path'),
  };
}

describe('ReputationGauge', () => {
  describe('boundary scores', () => {
    it('score 0: Newcomer, track only, no filled arc', () => {
      const { paths, svg } = setup({ score: 0 });
      expect(screen.getByText('Newcomer')).toBeInTheDocument();
      expect(paths).toHaveLength(1);
      expect(svg.querySelector('text')).toHaveTextContent('0');
      expect(screen.getByRole('img')).toHaveAttribute(
        'aria-label',
        'Reputation score: 0 — Newcomer'
      );
    });

    it('score 50: Newcomer with a filled arc', () => {
      const { paths } = setup({ score: 50 });
      expect(screen.getByText('Newcomer')).toBeInTheDocument();
      expect(paths).toHaveLength(2);
      expect(screen.getByRole('img')).toHaveAttribute(
        'aria-label',
        'Reputation score: 50 — Newcomer'
      );
    });

    it('score 100: first score in the Contributor tier', () => {
      setup({ score: 100 });
      expect(screen.getByText('Contributor')).toBeInTheDocument();
      expect(screen.getByRole('img')).toHaveAttribute(
        'aria-label',
        'Reputation score: 100 — Contributor'
      );
    });

    it('score 99 is still Newcomer', () => {
      setup({ score: 99 });
      expect(screen.getByText('Newcomer')).toBeInTheDocument();
    });

    it.each([
      [299, 'Contributor'],
      [300, 'Trusted'],
      [599, 'Trusted'],
      [600, 'Veteran'],
      [849, 'Veteran'],
      [850, 'Champion'],
      [1000, 'Champion'],
    ])('score %i maps to %s', (score, tier) => {
      setup({ score });
      expect(screen.getByText(tier)).toBeInTheDocument();
    });
  });

  describe('out-of-range and default scores', () => {
    it('defaults to 0 when no score is given', () => {
      setup({});
      expect(screen.getByRole('img')).toHaveAttribute(
        'aria-label',
        'Reputation score: 0 — Newcomer'
      );
    });

    it('clamps negative scores to 0', () => {
      const { paths } = setup({ score: -25 });
      expect(screen.getByRole('img')).toHaveAttribute(
        'aria-label',
        'Reputation score: 0 — Newcomer'
      );
      expect(paths).toHaveLength(1);
    });

    it('clamps scores above 1000 to 1000', () => {
      setup({ score: 5000 });
      expect(screen.getByRole('img')).toHaveAttribute(
        'aria-label',
        'Reputation score: 1000 — Champion'
      );
    });

    it('draws a longer arc for a higher score', () => {
      const lowPath = setup({ score: 100 }).paths[1].getAttribute('d');
      document.body.innerHTML = '';
      const highPath = setup({ score: 900 }).paths[1].getAttribute('d');
      expect(highPath).not.toEqual(lowPath);
    });
  });

  describe('SVG accessibility attributes', () => {
    it('exposes the gauge as a single labelled image', () => {
      setup({ score: 420 });
      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('aria-label', 'Reputation score: 420 — Trusted');
    });

    it('hides the decorative svg from assistive tech', () => {
      const { svg } = setup({ score: 420 });
      expect(svg).toHaveAttribute('aria-hidden', 'true');
    });

    it('renders the score and scale as text inside the svg', () => {
      const { svg } = setup({ score: 420 });
      const texts = [...svg.querySelectorAll('text')].map((t) => t.textContent);
      expect(texts).toEqual(['420', '/ 1000']);
    });

    it('scales the svg with the size prop', () => {
      const { svg } = setup({ score: 10, size: 200 });
      expect(svg).toHaveAttribute('width', '200');
      expect(svg).toHaveAttribute('height', '150');
      expect(svg).toHaveAttribute('viewBox', '0 0 200 200');
    });

    it('uses a 160px svg by default', () => {
      const { svg } = setup({ score: 10 });
      expect(svg).toHaveAttribute('width', '160');
      expect(svg).toHaveAttribute('viewBox', '0 0 160 160');
    });
  });
});
