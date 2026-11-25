/* global KeyboardEvent, HTMLElement */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import ModalAccessibilityManager from './ModalAccessibilityManager';

/**
 * jsdom has no layout, so offsetParent is always null and every element would
 * be treated as hidden by the manager's Tab handling. Report it as visible.
 */
let offsetParentSpy;

function addTrigger(label = 'Open') {
  const button = document.createElement('button');
  button.textContent = label;
  document.body.appendChild(button);
  button.focus();
  return button;
}

function addDialog({ closeLabel = 'Close dialog', inner = '' } = {}) {
  const dialog = document.createElement('div');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = `${closeLabel ? `<button aria-label="${closeLabel}">x</button>` : ''}${inner}`;
  document.body.appendChild(dialog);
  return dialog;
}

function pressKey(key, options = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  document.dispatchEvent(event);
  return event;
}

describe('ModalAccessibilityManager', () => {
  beforeEach(() => {
    offsetParentSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetParent', 'get')
      .mockImplementation(function () {
        return this.parentNode;
      });
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    offsetParentSpy.mockRestore();
  });

  it('renders nothing', () => {
    const { container } = render(<ModalAccessibilityManager />);
    expect(container).toBeEmptyDOMElement();
  });

  describe('Escape key handling', () => {
    it('clicks the close button of the open dialog and prevents default', () => {
      render(<ModalAccessibilityManager />);
      const dialog = addDialog();
      const onClose = vi.fn();
      dialog.querySelector('button').addEventListener('click', onClose);

      const event = pressKey('Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it('supports a data-modal-close element as the close control', () => {
      render(<ModalAccessibilityManager />);
      const dialog = addDialog({
        closeLabel: '',
        inner: '<span data-modal-close="true" tabindex="0">dismiss</span>',
      });
      const onClose = vi.fn();
      dialog.querySelector('[data-modal-close]').addEventListener('click', onClose);

      pressKey('Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('matches the close label case-insensitively', () => {
      render(<ModalAccessibilityManager />);
      const dialog = addDialog({ closeLabel: 'CLOSE' });
      const onClose = vi.fn();
      dialog.querySelector('button').addEventListener('click', onClose);
      pressKey('Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does nothing when no dialog is open', () => {
      render(<ModalAccessibilityManager />);
      const event = pressKey('Escape');
      expect(event.defaultPrevented).toBe(false);
    });

    it('does not prevent default when the dialog has no close control', () => {
      render(<ModalAccessibilityManager />);
      addDialog({ closeLabel: '', inner: '<button>Save</button>' });
      const event = pressKey('Escape');
      expect(event.defaultPrevented).toBe(false);
    });

    it('only closes the topmost dialog when several are stacked', () => {
      render(<ModalAccessibilityManager />);
      const bottom = addDialog();
      const top = addDialog();
      const bottomClose = vi.fn();
      const topClose = vi.fn();
      bottom.querySelector('button').addEventListener('click', bottomClose);
      top.querySelector('button').addEventListener('click', topClose);

      pressKey('Escape');
      expect(topClose).toHaveBeenCalledTimes(1);
      expect(bottomClose).not.toHaveBeenCalled();
    });

    it('ignores keys other than Escape and Tab', () => {
      render(<ModalAccessibilityManager />);
      const dialog = addDialog();
      const onClose = vi.fn();
      dialog.querySelector('button').addEventListener('click', onClose);
      const event = pressKey('Enter');
      expect(onClose).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it('stops listening after unmount', () => {
      const { unmount } = render(<ModalAccessibilityManager />);
      const dialog = addDialog();
      const onClose = vi.fn();
      dialog.querySelector('button').addEventListener('click', onClose);
      unmount();
      pressKey('Escape');
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('aria-hidden background management', () => {
    // The manager scopes behaviour to [aria-modal="true"] dialogs and does not
    // set aria-hidden on background content itself. These tests pin that
    // contract so a future change is a conscious one.
    it('leaves background content untouched while a dialog is open', async () => {
      const background = document.createElement('main');
      background.setAttribute('aria-hidden', 'false');
      document.body.appendChild(background);
      render(<ModalAccessibilityManager />);
      addDialog();
      await Promise.resolve();
      expect(background.getAttribute('aria-hidden')).toBe('false');
    });

    it('does not add aria-hidden to the dialog or its siblings', async () => {
      const sibling = document.createElement('div');
      document.body.appendChild(sibling);
      render(<ModalAccessibilityManager />);
      const dialog = addDialog();
      await Promise.resolve();
      expect(dialog).not.toHaveAttribute('aria-hidden');
      expect(sibling).not.toHaveAttribute('aria-hidden');
    });

    it('only treats aria-modal="true" as a dialog', () => {
      render(<ModalAccessibilityManager />);
      const notModal = document.createElement('div');
      notModal.setAttribute('aria-modal', 'false');
      notModal.innerHTML = '<button aria-label="Close">x</button>';
      document.body.appendChild(notModal);
      const onClose = vi.fn();
      notModal.querySelector('button').addEventListener('click', onClose);
      pressKey('Escape');
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('Tab focus containment', () => {
    it('wraps from the last to the first focusable element', () => {
      render(<ModalAccessibilityManager />);
      const dialog = addDialog({ closeLabel: 'Close', inner: '<button id="last">Last</button>' });
      const first = dialog.querySelector('button');
      const last = dialog.querySelector('#last');
      last.focus();
      const event = pressKey('Tab');
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);
    });

    it('wraps from the first to the last element on Shift+Tab', () => {
      render(<ModalAccessibilityManager />);
      const dialog = addDialog({ closeLabel: 'Close', inner: '<button id="last">Last</button>' });
      dialog.querySelector('button').focus();
      const event = pressKey('Tab', { shiftKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(dialog.querySelector('#last'));
    });

    it('pulls focus into the dialog when it is outside', () => {
      const outside = addTrigger();
      render(<ModalAccessibilityManager />);
      const dialog = addDialog();
      outside.focus();
      pressKey('Tab');
      expect(document.activeElement).toBe(dialog.querySelector('button'));
    });

    it('focuses the dialog itself when it has no focusable children', () => {
      render(<ModalAccessibilityManager />);
      const dialog = addDialog({ closeLabel: '', inner: '<p>Read only</p>' });
      const event = pressKey('Tab');
      expect(event.defaultPrevented).toBe(true);
      expect(dialog).toHaveAttribute('tabindex', '-1');
      expect(document.activeElement).toBe(dialog);
    });
  });

  describe('focus restoration', () => {
    it('returns focus to the trigger when the dialog is removed', async () => {
      const trigger = addTrigger();
      render(<ModalAccessibilityManager />);
      const dialog = addDialog();
      // Let the MutationObserver record the trigger, then move focus inside.
      await Promise.resolve();
      dialog.querySelector('button').focus();
      expect(document.activeElement).not.toBe(trigger);

      dialog.remove();
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    });

    it('does not try to focus a trigger that left the DOM', async () => {
      const trigger = addTrigger();
      render(<ModalAccessibilityManager />);
      const dialog = addDialog();
      await Promise.resolve();
      const focusSpy = vi.spyOn(trigger, 'focus');
      trigger.remove();
      dialog.remove();
      await Promise.resolve();
      await Promise.resolve();
      expect(focusSpy).not.toHaveBeenCalled();
    });

    it('records an already-open dialog on mount', async () => {
      const trigger = addTrigger();
      const dialog = addDialog();
      render(<ModalAccessibilityManager />);
      dialog.querySelector('button').focus();
      dialog.remove();
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    });
  });
});
