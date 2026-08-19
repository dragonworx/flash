# FS Spec

FS is a terminal based interactive console application which renders a path as a nicely rendered list of files and folders, with info similar to `ls`.

The app can be launched with `-d` pointing to a relative or absolute path. If no option passed, the current cwd will be used.

The app should be easily distributable, either as:
- a git repo you clone, build, and run
- a package through such ecosystems as nodejs, bun, or python (all requiring )
- a built binary through rust, or buns build system

The core idea of the app is to render a current path as files and folders, similar to a finder os window, where it could render with these view modes:
- list (icons, name.ext|folder, size, permissions, groups, owners etc, arranged as list from top of screen)
- grid (icons, names.ext|folders, arranged in grid with gap)

The app should:
- treat the available terminal screen space as the total available space to fit contents
- clear on render, to maintain free lines and draw styles
- render visually beautifully, using color and extended characters as possible to create windows, lines, columns, text rendering
- allow the user to move into folders by selecting and pressing space or enter
- allow the user to backtrack via the special path ".." or by pressing esc key
- allow the user to copy a folder for later paste
- allow the user to cut a folder (non-destructive until paste, but visual indication cut folder)
- support multiple selections, so that copy and paste are considerate of multiple sources/targets
- detect real-time changes and re-render/update
- allow the user to paste previously copied or cut items into current path, with progress indication (use smart conflict resolution, to intuitively increment and manage duplicate names side by side)
- allow the user to zip, unzip, and list (by virtually entering as a read-only folder) compressed archives
- allow the user to change permissions
- allow the user to rename files
- show a breadcrumb of the current path in a banner at the top, before any path contents is rendered

The app would be very useful inside a tmux-style app like herdr, where it could function to fill a dedicated panel and provide rich file support.

Design a plan that a junior dev can follow to execute successfully. When you are finished and are approved, switch to the sonnet model and implement the plan.
