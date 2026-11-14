// The system's own pickers (photos, files, folders), opened the one safe way.
//
// On iPhone a picker asked for while a pop-up window is still sliding away is thrown out with
// that window: the Photos button closed the Send sheet and then nothing came up. Every picker
// goes through here, and each waits until no pop-up is closing. Android gives each pop-up its
// own window, so the wait ends at once there.
//
// Call these, never the libraries' own launch functions, from the screens.

import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { whenModalsSettled } from "./modalStackStore";

export async function launchPhotoPicker(
  options: ImagePicker.ImagePickerOptions,
): Promise<ImagePicker.ImagePickerResult> {
  await whenModalsSettled();
  return ImagePicker.launchImageLibraryAsync(options);
}

export async function launchDocumentPicker(
  options: DocumentPicker.DocumentPickerOptions,
): Promise<DocumentPicker.DocumentPickerResult> {
  await whenModalsSettled();
  return DocumentPicker.getDocumentAsync(options);
}

/** Wait here before any other screen iOS presents itself (a folder picker, the share sheet). */
export async function beforeSystemScreen(): Promise<void> {
  await whenModalsSettled();
}
