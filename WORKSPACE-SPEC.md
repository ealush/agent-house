# Command-Driven Workspace & Tiling UI

> The owner's product and interaction specification for the workspace, supplied on 24 October 2026. It refines the keyboard, palette and tiling parts of [SPEC.md](SPEC.md); where they differ, this one wins for the workspace. Status per requirement is tracked in [docs/native/PARITY.md](docs/native/PARITY.md#keyboard-first-workspace) (KW- rows).

## Product vision

Build a sophisticated, keyboard-first workspace that combines the command palette of VS Code, the tiling and navigation ergonomics of Omarchy/Hyprland, and the visual refinement of a premium native application.

The entire application should feel like one cohesive environment where every capability is discoverable, every operation can be performed without a mouse, and navigating between multiple simultaneous panes feels completely natural.

This specification concerns only the workspace UI, interaction model, navigation, and visual experience. The content rendered inside individual panes is deliberately outside its scope. Assume panes can contain independent interactive sessions, such as AI conversations.

## 1. Universal command palette

The command palette is the central interaction mechanism of the application, not merely a searchable list of miscellaneous commands.

Every user-facing application action must be discoverable and executable through it, including actions that are otherwise accessible through buttons, menus, contextual controls, or keyboard shortcuts.

Take inspiration from VS Code’s command palette and Omarchy’s hierarchical application menu.

### Interaction model

* A global keyboard shortcut opens the palette instantly from anywhere.
* Commands are organized into logical, nested categories, such as Workspace, Panes, Sessions, Navigation, View, and Settings.
* Categories form a navigable tree. Selecting a category reveals its children without opening another window.
* Each row has a recognizable icon on the left, a clear action label, and its associated keyboard shortcut aligned to the right.
* Navigation is entirely keyboard-accessible: arrow keys move through items, Enter opens or executes, and Backspace/Left navigates backward.
* Search is available immediately upon opening and uses fast, forgiving fuzzy matching.
* Search should discover deeply nested commands without requiring the user to manually traverse their category hierarchy.
* Context-sensitive commands should reflect the current workspace and active pane.
* Recently used and frequently relevant actions may be surfaced intelligently, without making the interface unpredictable.

### Session discovery

Session search is an integral part of the command palette, rather than an unrelated UI.

Typing a session’s name or other identifying information should surface matching sessions alongside ordinary commands. A dedicated Go to Session branch can expose more focused search and navigation.

Results should be clearly differentiated from actions, show useful identifying context, and support keyboard selection. Selecting a session should navigate to it and correctly establish focus.

The palette can also expose contextual destinations such as Switch to Session, Open in Pane, or Move to Workspace, where supported by the host application.

### Visual language

The palette should be a beautiful, compact floating surface with:

* Carefully balanced typography and spacing.
* Consistent iconography, with shortcuts presented as subtle keycaps.
* Clear selection highlighting and lightweight hierarchy indicators.
* Smooth transitions between nested levels.
* A strong sense of depth and layering without excessive translucency or decoration.

It should feel immediate and responsive, including when searching large numbers of commands or sessions.

## 2. VS Code-style keyboard shortcuts editor

Provide a dedicated keyboard shortcuts interface inspired by VS Code’s keybindings settings.

Users should be able to discover, inspect, customize, and reset shortcuts without manually editing configuration files.

The interface should support:

* Searching commands by name, category, or assigned shortcut.
* Viewing the current binding associated with each command.
* Clicking or selecting an action and recording a new key combination directly from the keyboard.
* Multi-key chords where appropriate.
* Detecting shortcut conflicts and providing clear ways to resolve them.
* Restoring an individual shortcut or the entire keymap to defaults.
* Distinguishing application-wide shortcuts from those that apply only in a particular context.

Shortcut customization should feel like a first-class feature, not an advanced configuration screen.

The command palette and shortcuts editor must always remain consistent: changing a binding updates its representation everywhere in the interface.

Consider a lightweight, contextual shortcut-discovery overlay, similar to which-key, that helps users discover commands while learning the application.

## 3. Omarchy/Hyprland-style tiling workspace

The main workspace supports multiple independently interactive panes arranged using a flexible, recursively splittable tiling system.

Think of a polished, embedded window manager rather than a conventional dashboard grid.

### Layout capabilities

* Split any pane horizontally or vertically, creating panes beside, above, or below the original.
* Repeatedly split individual panes to construct arbitrarily nested layouts.
* Resize adjacent panes by dragging dividers or using keyboard commands.
* Move, swap, and rearrange panes using keyboard shortcuts or pointer interactions.
* Close individual panes, allowing the surrounding layout to reclaim their space naturally.
* Maximize or temporarily zoom into an individual pane, then return to the previous arrangement.
* Support multiple workspaces or layout groups, with convenient keyboard navigation between them.
* Provide sensible layout operations such as balancing sizes or rotating a split where useful.

A split should apply to the currently focused pane, rather than arbitrarily splitting the entire workspace.

For example, a user should be able to create two columns, split the right column into upper and lower panes, then further split the lower pane. No predefined grid should limit this composition.

All these capabilities must also appear in the universal command palette.

### Pane identity and focus

At any moment, there is one clearly identifiable active pane.

The active pane receives a subtle but unmistakable visual distinction, preferably an accent-colored border or comparable focus treatment.

Avoid heavy window chrome, oversized toolbars, or decorative containers that waste content space. Panes should feel like tightly integrated surfaces within one workspace.

## 4. Seamless keyboard and pointer navigation

Focus management is one of the most important quality requirements of this entire experience.

Navigating between panes should feel as effortless as navigating windows in Hyprland.

### Directional navigation

* Keyboard commands move focus left, right, up, or down.
* Navigation follows the actual spatial arrangement of panes, including complex nested layouts.
* Moving focus must immediately transfer real keyboard focus to the destination pane, not merely update its visual selection.
* The previously focused pane loses its active state, and the destination visibly becomes active.
* When appropriate, the application remembers the meaningful focus location within each pane.

For example, moving from an input field in the left pane to the right pane should allow the user to start typing in the right pane immediately, without requiring a click.

### Hover-to-focus

On pointer-based devices, hovering over another pane should make it the active pane and transfer focus, in the spirit of focus-follows-mouse window managers.

This must work predictably and avoid focus flicker or accidental changes during operations such as resizing, dragging, or interacting with overlays.

### Focus correctness

Focus behavior must remain reliable during all workspace operations:

* Creating or splitting a pane.
* Moving, swapping, closing, or maximizing panes.
* Switching sessions or workspaces.
* Opening and dismissing the command palette or other temporary interfaces.
* Moving between keyboard navigation and mouse interaction.

Temporary interfaces should restore focus appropriately when dismissed. Deliberate navigation should focus the newly selected destination.

Global keyboard shortcuts should remain accessible while interacting with pane content, while avoiding unnecessary interference with text input or other native controls.

The user’s mental model should always match reality: the pane that looks focused is the pane that actually receives input.

## 5. Unified interaction model

The command palette, keybinding system, and tiling workspace should behave as different interfaces to the same set of capabilities.

For example, Split Pane Right might be invoked by:

1. Finding it through the command palette.
2. Executing its assigned keyboard shortcut.
3. Choosing it from a pane’s contextual menu.
4. Using an appropriate visible UI control.

All four paths should produce the same behavior, state changes, focus transitions, and visual feedback.

This consistency is essential. There should be no hidden secondary interaction model or commands that only work through an obscure shortcut.

The application should be discoverable for newcomers while becoming exceptionally fast for experienced keyboard users.

## 6. Visual design, motion, and craftsmanship

Aim for Omarchy-level ergonomics with Apple-level finish.

The visual design should feel modern, deliberate, and sophisticated rather than like a generic web dashboard.

### Design principles

* Minimal, functional chrome with strong visual hierarchy.
* Consistent typography, icons, spacing, borders, and surface treatments.
* Thoughtful use of accent colors to communicate focus and selection.
* Beautiful floating surfaces for palettes, menus, and overlays.
* Dense enough for power users without feeling visually crowded.
* Cohesive appearance across commands, shortcuts, panes, and workspace navigation.

### Motion and transitions

Animations should reinforce spatial continuity and make the interface easier to understand.

Splitting a pane should feel like the existing surface naturally making room for another. Closing a pane should smoothly return its space to neighboring panes. Maximizing and restoring should preserve the user’s understanding of where the pane belongs.

Command palette transitions, selection changes, layout rearrangements, and focus changes should all receive comparable attention.

Motion should be subtle, fast, and purposeful. Never sacrifice responsiveness for animation.

### Interaction quality

Pay particular attention to the details that distinguish excellent desktop software from merely functional software:

* No focus glitches or lost keystrokes.
* No unexpected keyboard shortcut conflicts.
* No layout jumps or visible flicker during routine operations.
* No unnecessary modal interruptions.
* No ambiguity about which pane is active.
* Clear hover, pressed, selected, and disabled states.
* Smooth, precise divider dragging and pane rearrangement.
* Appropriate behavior when the viewport becomes too small for the current layout.
* Respect for accessibility settings and reduced-motion preferences.

The application should feel polished under rapid, repetitive keyboard interaction, not only during slow demonstrations.

## 7. Product quality bar

The goal is not to reproduce VS Code or Hyprland literally. It is to capture the principles that make their interaction models powerful and adapt them into a cohesive, original application.

A user should be able to open the application and, without reaching for the mouse:

* Discover any available action.
* Find and switch to an existing session.
* Create complex multi-pane arrangements.
* Move naturally between panes in any direction.
* Rearrange, resize, maximize, and close panes.
* Navigate between workspaces.
* Customize their own keyboard shortcuts.
* Always know which pane currently owns keyboard focus.

All of this should feel fast, fluid, reliable, and visually exceptional.

Implementation freedom: Treat this as a product and interaction specification, not a rigid blueprint. Choose sensible default shortcuts, animations, layout rules, and presentation details that best fit the host application and platform. Prefer coherent, native-feeling behavior over slavishly copying any reference product.

The defining success criterion is simple: the workspace should feel like a beautifully designed, keyboard-native operating environment embedded inside the application.
