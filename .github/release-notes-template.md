<!--
Write what this version brings, for the people who run a table. The app shows this text,
with its pictures, before anyone chooses to update. Drag pictures into the editor to add them.
If something stops working the way it did, add a heading named "Breaking changes" (two # signs)
and say what changes and what people must do. The app shows that part first, in red.

Lines already filled in below were collected since the last release by the pull requests
that caused them. Keep them, add yours, and empty the lists again after publishing.
-->

## Breaking changes

- Site format 2: the base map is a layer. Older sites are upgraded when opened, and the original file is kept beside the new one as `site.format-1.json`.
- Site format 3: every layer in a table has its own id, layers can hold items, a slideshow can be a sequence of layers, and custom layers are saved in the table. Older tables are upgraded when opened, and the original file is kept as `site.format-2.json`. A format 3 table does not open in an older version of the app.
- Tables that hide some of a layer's controls (a new choice in the editor) do not open in an older version of the app. Update the app on every computer that opens them.

## New

- 

## Fixes

- 
