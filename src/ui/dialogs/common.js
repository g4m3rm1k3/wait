/** Behaviour shared by every dialog: close buttons and clicking outside to close. */
import { $$ } from '../dom.js';

export function setupDialogClosing() {
  for (const button of $$('.close-dialog')) button.onclick = () => button.closest('dialog').close();

  for (const dialog of $$('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      // A click on the dialog element itself is either its padding or the backdrop.
      const box = dialog.getBoundingClientRect();
      const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
      if (outside) dialog.close();
    });
  }
}
