# Field walk

## What it shows

Before the table, visitors walk around the place with their phones and mark the spots they notice, each with a photo or a sound. Back at the table every spot shows as a dot in its walker's colour, each person's spots joined faintly in the order they took them. Sound spots ripple. On the controller, the spot picked fills the screen: the photo, or a big play button over the sound's waveform, with the walker's animal, name, time and note.

![A photo on the controller](docs/screenshots/445-controller-photo.png)

![The walks on the table](docs/screenshots/445-table.png)

## Good for

Bringing what a group saw and heard outside back into the room, so people talk about real places: a busy crossing, a quiet corner, the noise from a road.

## Set it up

1. Add **Field walk** to the table from **Insert › New layer**. Phones can't turn it on or off; only the controller does.
2. Visitors join with the QR code as usual. At the top of their phone page a **Field walk** card has **Mark a spot**.
3. Out on the walk, a phone finds itself by GPS, or the visitor taps where they are on the small map. They take a photo or record a sound (up to a minute), add a few words if they like, and **Save spot**.
4. Spots are kept on the phone and sent whenever the table can be reached, so walking out of Wi-Fi range or the screen going dark loses nothing. Keep the page open until the list says **On the table**.
5. Back at the table, open **Field walk** on the controller. Pick a spot from the strip, with ‹ and ›, or click its dot on the table. A sound plays on the controller's speakers.

## With other layers

Field walk is a layer like any other: picking another layer closes it. To see the spots under a Reveal line or a Magnifier's X-ray, add Field walk inside that layer in the editor; it then opens with it.

## Tips

- GPS and recording need the phone page over HTTPS: the join page (the default QR code) or a relay. On plain local Wi-Fi, phones tap the map and pick a recording from the phone instead.
- Photos and sounds stay on the studio computer, in the table folder's hidden `.mrstudio/field`, and are left out when the table is shared. **Clear the walk** deletes them all (press it twice); **Remove this spot** deletes one.
- A walk lasts one session. While the table keeps running, phones and the table keep every spot, also across reloads. When the table starts again it starts a new, empty walk, and each phone empties its list the next time it connects. The last session's walk is put aside in `.mrstudio/field-previous` in case the table was restarted by mistake; the session after that replaces it.
- Visitors can delete any of their own spots on the phone with ×, also once it is on the table. A spot the guide removed or cleared goes from the visitor's phone too.
- Only spots on the table's map can be saved.
