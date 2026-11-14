import React, { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { Modal, Platform, type ModalProps } from "react-native";
import { dismissed, isPresented, requestClose, requestOpen } from "../lib/modalStack";
import {
  getModalStack,
  newModalId,
  subscribeModalStack,
  updateModalStack,
} from "../lib/modalStackStore";

// Use this instead of React Native's <Modal> everywhere in the app.
//
// On iOS only one top-level modal can be on screen. Opening a second one while the first is up
// (the folder view, then the player) made iOS refuse the second, and closing the first then left
// the whole app frozen. AppModal queues them: the modal on top is shown, the one beneath steps
// aside and comes back when the top one closes. Android is unchanged (each modal has its own
// window there). A modal rendered INSIDE another modal is presented from that modal, which iOS
// allows, so it is passed straight through.

/** True for everything rendered inside a modal. */
export const InsideModal = createContext(false);

export function AppModal(props: ModalProps): React.ReactElement {
  const nested = useContext(InsideModal);
  if (Platform.OS !== "ios" || nested) {
    return (
      <Modal {...props}>
        <InsideModal.Provider value={true}>{props.children}</InsideModal.Provider>
      </Modal>
    );
  }
  return <StackedModal {...props} />;
}

function StackedModal({ visible = true, onDismiss, children, ...rest }: ModalProps): React.ReactElement {
  const idRef = useRef<string>("");
  if (!idRef.current) idRef.current = newModalId();
  const id = idRef.current;
  const stack = useSyncExternalStore(subscribeModalStack, getModalStack, getModalStack);

  useEffect(() => {
    updateModalStack((s) => (visible ? requestOpen(s, id) : requestClose(s, id)));
  }, [visible, id]);

  // Unmounted while open: it leaves the queue, and the store's timer frees the screen.
  useEffect(() => () => updateModalStack((s) => requestClose(s, id)), [id]);

  return (
    <Modal
      {...rest}
      visible={visible && isPresented(stack, id)}
      onDismiss={() => {
        updateModalStack((s) => dismissed(s, id));
        onDismiss?.();
      }}
    >
      <InsideModal.Provider value={true}>{children}</InsideModal.Provider>
    </Modal>
  );
}
