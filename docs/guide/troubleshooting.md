# When something is wrong

*The usual problems, what causes them and how to fix them. Find yours by what you see.*

## The projection does not line up with the model

1. Add the **Table grid** layer and look at the model: the lines should sit on the seams between the tiles.
2. If they do not, open the **Display** tab and press **Calibrate**. Drag each marker onto the matching corner of the physical model.
3. If the map is turned or mirrored, check the table's place and turn (Table settings, **Place**), and how the projector is mounted.

## The map or the controller opens on the wrong screen

1. Open the **Display** tab and press **Identify**. Every screen shows its number.
2. Under **Screens**, choose which number is the table (the projector) and which is the controller.
3. If a screen is missing, check that the computer sees it in its own display settings, then open the Display tab again.

## A layer stays empty

- Most layers need data from the place: Traffic and Street life need **streets**, Building lights and Sunlight need **buildings**, Cool paths needs **walking paths**, Trees needs **trees**. The editor says what is missing beside the layer and takes you to **Add data**.
- In **Add data**, **From OpenStreetMap** fetches buildings, streets, walking paths and trees around the table. **Ground** fetches free ground heights.
- Live layers (live public transport, web maps, map styles from your sources) need the internet and, for some, a key under **Sources and keys** on Home.

## OpenStreetMap takes a long time or fails

OpenStreetMap's servers are shared and sometimes busy. MR Studio waits, tries again and moves to other servers by itself, which can take a minute. **Fetch everything from open data** asks OpenStreetMap once for all its datasets, which is kinder to the servers than one at a time. If it still fails, press **Try again** on that line later, or bring in a file of your own instead.

## The map pictures or the Help pictures are missing

The aerial photo, ready-made map styles, web maps and the pictures in this Help come from the internet. The first time needs a connection; MR Studio keeps map pictures for the table afterwards, so a table that has been shown once works offline.

## A key or a source does not work

1. On Home, open **Sources and keys** and press **Test** beside the source. It says whether the key is accepted.
2. Copy the key again from the provider's site; a missing character is the usual cause.
3. Keys are kept in this computer's keychain and never travel with an exported table, so a table moved to another computer needs its keys added there.

## Phones cannot join

1. Visitors scan the code on the controller. On the same Wi-Fi as the table's computer, phones join directly.
2. Many venue networks keep devices apart ("guest Wi-Fi"). Then phones need the **phone relay**: set it up under **Sources and keys** on Home, and the code on the controller switches to it.
3. Check that the phone is not on mobile data only while the table has no relay.

## The table is slow or jerky

1. On the **Display** tab, set **Quality** to **Draft**.
2. In heavy layers (Wind, Stormwater), set **Detail** to **Coarse** or lower the number of drops or particles.
3. Close other programs, and keep the laptop on its charger: many computers slow down on battery.

## A window went blank or froze

MR Studio watches its windows while presenting and reloads one that stops drawing. It writes what happened in the **operator log**: Home, **Displays and settings**, **Show the operator log**. While presenting, Ctrl+Shift+E brings the editor back.

## The app will not open the first time

- **Mac**: macOS may say the app is from an unidentified developer. Open **System Settings**, **Privacy and Security**, and press **Open Anyway** beside MR Studio. You only do this once per version.
- **Windows**: if Windows protected your PC, choose **More info**, then **Run anyway**.

## An update does not install by itself

Home says when a new version is out. Press **Download**, open the file it saves, and install it over the old version: your tables and keys stay as they are. Keep every computer that shares tables on the same version, since a table saved by a newer version may not open in an older one.

## Still stuck

Note what you did, what you expected and what happened, with the version shown at the top of Home, and send it with the day's operator log to whoever looks after your MR Studio.
