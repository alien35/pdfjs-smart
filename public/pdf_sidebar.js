/* Copyright 2016 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { PDFViewerApplication } from "./app.js";
import {
  PresentationModeState,
  RenderingStates,
  SidebarView,
  toggleCheckedBtn,
} from "./ui_utils.js";

import { getDocument } from "pdfjs-lib";
console.log(getDocument, 'getDocument')

const UI_NOTIFICATION_CLASS = "pdfSidebarNotification";

/**
 * @typedef {Object} PDFSidebarOptions
 * @property {PDFSidebarElements} elements - The DOM elements.
 * @property {PDFViewer} pdfViewer - The document viewer.
 * @property {PDFThumbnailViewer} pdfThumbnailViewer - The thumbnail viewer.
 * @property {EventBus} eventBus - The application event bus.
 * @property {IL10n} l10n - The localization service.
 */

/**
 * @typedef {Object} PDFSidebarElements
 * @property {HTMLDivElement} outerContainer - The outer container
 *   (encasing both the viewer and sidebar elements).
 * @property {HTMLDivElement} sidebarContainer - The sidebar container
 *   (in which the views are placed).
 * @property {HTMLButtonElement} toggleButton - The button used for
 *   opening/closing the sidebar.
 * @property {HTMLButtonElement} thumbnailButton - The button used to show
 *   the thumbnail view.
 * @property {HTMLButtonElement} outlineButton - The button used to show
 *   the outline view.
 * @property {HTMLButtonElement} attachmentsButton - The button used to show
 *   the attachments view.
 * @property {HTMLButtonElement} layersButton - The button used to show
 *   the layers view.
 * @property {HTMLDivElement} thumbnailView - The container in which
 *   the thumbnails are placed.
 * @property {HTMLDivElement} outlineView - The container in which
 *   the outline is placed.
 * @property {HTMLDivElement} attachmentsView - The container in which
 *   the attachments are placed.
 * @property {HTMLDivElement} layersView - The container in which
 *   the layers are placed.
 * @property {HTMLDivElement} outlineOptionsContainer - The container in which
 *   the outline view-specific option button(s) are placed.
 * @property {HTMLButtonElement} currentOutlineItemButton - The button used to
 *   find the current outline item.
 */

const OPENAI_ENDPOINT = "https://api.openai.com/v1/engines/text-davinci-003/completions";

async function askChatGpt(question, apiKey, maxTokens = 2048) {
  try {
    const response = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        prompt: question,
        max_tokens: maxTokens,
      }),
    });

    const responseData = await response.json();
    if (response.ok) {
      return responseData.choices[0].text;
    } else {
      throw new Error(responseData.message);
    }
  } catch (error) {
    console.error("Error while fetching response from OpenAI API:", error);
    throw error;
  }
}

async function getAnswersFromChunks(chunks, question, apiKey) {
  const answers = [];

  for (const chunk of chunks) {
    const answer = await askChatGpt(`${chunk}\n\nQ: ${question}`, apiKey);
    answers.push(answer);
  }

  return answers;
}

async function getMostRelevantAnswer(answers, prompt, apiKey) {
  let rankingPrompt = `Which of the following answers best describes: ${prompt}? Answer as though only answering this prompt: ${prompt}:\n`;

  answers.forEach((answer, index) => {
    rankingPrompt += `${index + 1}. ${answer}\n`;
  });

  rankingPrompt += "Respond exclusively with a number. Please provide the index number of the best answer:";

  const response = await askChatGpt(rankingPrompt, apiKey);
  console.log(response, 'response bee')
  const chosenAnswerIndex = parseInt(response.trim()) - 1;
  return answers[chosenAnswerIndex];
}

async function testAPIKey(apiKey) {
  return askChatGpt("Hello world", apiKey, 10);
}


class PDFSidebar {
  /**
   * @param {PDFSidebarOptions} options
   */
  constructor({ elements, pdfViewer, pdfThumbnailViewer, eventBus, l10n }) {
    this.isOpen = false;
    this.isChatOpen = false;
    this.active = SidebarView.THUMBS;
    this.isInitialViewSet = false;
    this.isInitialEventDispatched = false;
    this.openAIKey = "";

    /**
     * Callback used when the sidebar has been opened/closed, to ensure that
     * the viewers (PDFViewer/PDFThumbnailViewer) are updated correctly.
     */
    this.onToggled = null;
    this.onChatToggled = null;

    this.pdfViewer = pdfViewer;
    this.pdfThumbnailViewer = pdfThumbnailViewer;

    this.outerContainer = elements.outerContainer;
    this.sidebarContainer = elements.sidebarContainer;
    this.toggleButton = elements.toggleButton;  
    this.chatToggleButton = elements.chatToggleButton;
    this.chatSubmitButton = elements.chatSubmitButton;
    this.apiKeySubmitButton = elements.apiKeySubmitButton;
    this.apiKeyInput = elements.apiKeyInput;
    this.apiKeyContainer = elements.apiKeyContainer;
    this.chatBox = elements.chatBox;
    this.chatInput = elements.chatInput;
    this.chatMessage = elements.chatMessage;

    this.thumbnailButton = elements.thumbnailButton;
    this.outlineButton = elements.outlineButton;
    this.attachmentsButton = elements.attachmentsButton;
    this.layersButton = elements.layersButton;

    this.thumbnailView = elements.thumbnailView;
    this.outlineView = elements.outlineView;
    this.attachmentsView = elements.attachmentsView;
    this.layersView = elements.layersView;

    this._outlineOptionsContainer = elements.outlineOptionsContainer;
    this._currentOutlineItemButton = elements.currentOutlineItemButton;

    this.eventBus = eventBus;
    this.l10n = l10n;

    this.#addEventListeners();
    this.textItems = [];
    let currentText = "";

    PDFViewerApplication.eventBus.on("textlayerrendered", (ev) => {
      const textLayer = ev.source.textLayer.textContentItemsStr;

      for (const item of textLayer) {
        currentText += item + " ";

        if (currentText.split(" ").length >= 2048) {
          this.textItems.push(currentText.trim());
          currentText = "";
        }
      }

      // When the last text layer is rendered, push the remaining text to textItems
      if (ev.source.textLayer.renderingDone) {
        if (currentText) {
          this.textItems.push(currentText.trim());
          currentText = "";
        }
      }

    });
    

  }

  reset() {
    this.isInitialViewSet = false;
    this.isInitialEventDispatched = false;

    this.#hideUINotification(/* reset = */ true);
    this.switchView(SidebarView.THUMBS);

    this.outlineButton.disabled = false;
    this.attachmentsButton.disabled = false;
    this.layersButton.disabled = false;
    this._currentOutlineItemButton.disabled = true;
  }

  /**
   * @type {number} One of the values in {SidebarView}.
   */
  get visibleView() {
    return this.isOpen ? this.active : SidebarView.NONE;
  }

  /**
   * @param {number} view - The sidebar view that should become visible,
   *                        must be one of the values in {SidebarView}.
   */
  setInitialView(view = SidebarView.NONE) {
    if (this.isInitialViewSet) {
      return;
    }
    this.isInitialViewSet = true;

    // If the user has already manually opened the sidebar, immediately closing
    // it would be bad UX; also ignore the "unknown" sidebar view value.
    if (view === SidebarView.NONE || view === SidebarView.UNKNOWN) {
      this.#dispatchEvent();
      return;
    }
    this.switchView(view, /* forceOpen = */ true);

    // Prevent dispatching two back-to-back "sidebarviewchanged" events,
    // since `this.switchView` dispatched the event if the view changed.
    if (!this.isInitialEventDispatched) {
      this.#dispatchEvent();
    }
  }

  /**
   * @param {number} view - The sidebar view that should be switched to,
   *                        must be one of the values in {SidebarView}.
   * @param {boolean} [forceOpen] - Ensure that the sidebar is open.
   *                                The default value is `false`.
   */
  switchView(view, forceOpen = false) {
    const isViewChanged = view !== this.active;
    let forceRendering = false;

    switch (view) {
      case SidebarView.NONE:
        if (this.isOpen) {
          this.close();
        }
        return; // Closing will trigger rendering and dispatch the event.
      case SidebarView.THUMBS:
        if (this.isOpen && isViewChanged) {
          forceRendering = true;
        }
        break;
      case SidebarView.OUTLINE:
        if (this.outlineButton.disabled) {
          return;
        }
        break;
      case SidebarView.ATTACHMENTS:
        if (this.attachmentsButton.disabled) {
          return;
        }
        break;
      case SidebarView.LAYERS:
        if (this.layersButton.disabled) {
          return;
        }
        break;
      default:
        console.error(`PDFSidebar.switchView: "${view}" is not a valid view.`);
        return;
    }
    // Update the active view *after* it has been validated above,
    // in order to prevent setting it to an invalid state.
    this.active = view;

    // Update the CSS classes (and aria attributes), for all buttons and views.
    toggleCheckedBtn(
      this.thumbnailButton,
      view === SidebarView.THUMBS,
      this.thumbnailView
    );
    toggleCheckedBtn(
      this.outlineButton,
      view === SidebarView.OUTLINE,
      this.outlineView
    );
    toggleCheckedBtn(
      this.attachmentsButton,
      view === SidebarView.ATTACHMENTS,
      this.attachmentsView
    );
    toggleCheckedBtn(
      this.layersButton,
      view === SidebarView.LAYERS,
      this.layersView
    );

    // Finally, update view-specific CSS classes.
    this._outlineOptionsContainer.classList.toggle(
      "hidden",
      view !== SidebarView.OUTLINE
    );

    if (forceOpen && !this.isOpen) {
      this.open();
      return; // Opening will trigger rendering and dispatch the event.
    }
    if (forceRendering) {
      this.#updateThumbnailViewer();
      this.onToggled();
      this.onChatToggled();
    }
    if (isViewChanged) {
      this.#dispatchEvent();
    }
  }

  open() {
    if (this.isOpen) {
      return;
    }
    this.isOpen = true;
    this.toggleButton.classList.add("toggled");
    this.toggleButton.setAttribute("aria-expanded", "true");

    this.outerContainer.classList.add("sidebarMoving", "sidebarOpen");

    if (this.active === SidebarView.THUMBS) {
      this.#updateThumbnailViewer();
    }
    this.onToggled();
    this.#dispatchEvent();

    this.#hideUINotification();
  }

  close() {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    this.toggleButton.classList.remove("toggled");
    this.toggleButton.setAttribute("aria-expanded", "false");

    this.outerContainer.classList.add("sidebarMoving");
    this.outerContainer.classList.remove("sidebarOpen");

    this.onToggled();
    this.#dispatchEvent();
  }

  openChat() {
    if (this.isChatOpen) {
      return;
    }
    this.isChatOpen = true;
    this.chatToggleButton.classList.add("toggled");
    this.chatToggleButton.setAttribute("aria-expanded", "true");

    this.outerContainer.classList.add("chatSidebarMoving", "chatSidebarOpen");

    this.onChatToggled();
    this.#dispatchEvent();

    this.#hideUINotification();
  }

  closeChat() {
    if (!this.isChatOpen) {
      return;
    }
    this.isChatOpen = false;
    this.chatToggleButton.classList.remove("toggled");
    this.chatToggleButton.setAttribute("aria-expanded", "false");

    this.outerContainer.classList.add("chatSidebarMoving");
    this.outerContainer.classList.remove("chatSidebarOpen");

    this.onChatToggled();
    this.#dispatchEvent();
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  toggleChat() {
    if (this.isChatOpen) {
      this.closeChat();
    } else {
      this.openChat();
    }
  }

  #dispatchEvent() {
    if (this.isInitialViewSet && !this.isInitialEventDispatched) {
      this.isInitialEventDispatched = true;
    }

    this.eventBus.dispatch("sidebarviewchanged", {
      source: this,
      view: this.visibleView,
    });
  }

  #updateThumbnailViewer() {
    const { pdfViewer, pdfThumbnailViewer } = this;

    // Use the rendered pages to set the corresponding thumbnail images.
    const pagesCount = pdfViewer.pagesCount;
    for (let pageIndex = 0; pageIndex < pagesCount; pageIndex++) {
      const pageView = pdfViewer.getPageView(pageIndex);
      if (pageView?.renderingState === RenderingStates.FINISHED) {
        const thumbnailView = pdfThumbnailViewer.getThumbnail(pageIndex);
        thumbnailView.setImage(pageView);
      }
    }
    pdfThumbnailViewer.scrollThumbnailIntoView(pdfViewer.currentPageNumber);
  }

  #showUINotification() {
    this.toggleButton.setAttribute(
      "data-l10n-id",
      "toggle_sidebar_notification2"
    );
    this.l10n.translate(this.toggleButton);

    if (!this.isOpen) {
      // Only show the notification on the `toggleButton` if the sidebar is
      // currently closed, to avoid unnecessarily bothering the user.
      this.toggleButton.classList.add(UI_NOTIFICATION_CLASS);
    }
  }

  #hideUINotification(reset = false) {
    if (this.isOpen || reset) {
      // Only hide the notification on the `toggleButton` if the sidebar is
      // currently open, or when the current PDF document is being closed.
      this.toggleButton.classList.remove(UI_NOTIFICATION_CLASS);
    }

    if (reset) {
      this.toggleButton.setAttribute("data-l10n-id", "toggle_sidebar");
      this.l10n.translate(this.toggleButton);
    }
  }

  #addEventListeners() {
    this.sidebarContainer.addEventListener("transitionend", evt => {
      if (evt.target === this.sidebarContainer) {
        this.outerContainer.classList.remove("sidebarMoving");
      }
    });

    this.toggleButton.addEventListener("click", () => {
      this.toggle();
    });

    this.chatToggleButton.addEventListener("click", () => {
      this.toggleChat();
    });

    this.apiKeySubmitButton.addEventListener("click", async () => {
      const apiKeyCandidate = this.apiKeyInput.value;
      try {
        const result = await testAPIKey(apiKeyCandidate);
        console.log(result, 'result')
        if (result) {
          this.openAIKey = apiKeyCandidate;
          this.apiKeyContainer.style.display = "none";
          this.chatInput.style.display = "block";
        } else {
          alert("Please enter a valid API key");
        }
      } catch (err) {
        console.log(err, 'err here')
        alert("Please enter a valid API key");
      }
    });

    // Buttons for switching views.
    this.thumbnailButton.addEventListener("click", () => {
      this.switchView(SidebarView.THUMBS);
    });

    this.outlineButton.addEventListener("click", () => {
      this.switchView(SidebarView.OUTLINE);
    });
    this.outlineButton.addEventListener("dblclick", () => {
      this.eventBus.dispatch("toggleoutlinetree", { source: this });
    });

    this.attachmentsButton.addEventListener("click", () => {
      this.switchView(SidebarView.ATTACHMENTS);
    });

    this.chatSubmitButton.addEventListener("click", async () => {
      const userMessage = this.chatMessage.value?.trim();
      if (!userMessage) {
        return;
      }

      // Create a new element for the user's message and add the appropriate class and content
      const userMessageElement = document.createElement('div');
      userMessageElement.className = 'user-message';
      userMessageElement.textContent = userMessage;

      // Append the user's message to the chat box
      this.chatBox.appendChild(userMessageElement);

      // Add your API request logic here, as described in the previous response

      // Clear the input field after sending the message
      this.chatMessage.value = '';
      
      try {
        console.log(this.textItems, 'this.textItems')
        console.log(this.openAIKey, 'open key')
        const answers = await getAnswersFromChunks(this.textItems, userMessage, this.openAIKey);
        const mostRelevantAnswer = await getMostRelevantAnswer(answers, userMessage, this.openAIKey);
        console.log(mostRelevantAnswer, 'mostRelevantAnswer')
        const chatGptMessageElement = document.createElement('div');
        chatGptMessageElement.className = 'bot-message';
        chatGptMessageElement.textContent = mostRelevantAnswer;

        // Append the ChatGPT response to the chat box
        this.chatBox.appendChild(chatGptMessageElement);

      } catch (error) {
        // Handle any errors that occurred during the request
        console.error('API request error:', error);
      }
    });

    this.layersButton.addEventListener("click", () => {
      this.switchView(SidebarView.LAYERS);
    });
    this.layersButton.addEventListener("dblclick", () => {
      this.eventBus.dispatch("resetlayers", { source: this });
    });

    // Buttons for view-specific options.
    this._currentOutlineItemButton.addEventListener("click", () => {
      this.eventBus.dispatch("currentoutlineitem", { source: this });
    });

    // Disable/enable views.
    const onTreeLoaded = (count, button, view) => {
      button.disabled = !count;

      if (count) {
        this.#showUINotification();
      } else if (this.active === view) {
        // If the `view` was opened by the user during document load,
        // switch away from it if it turns out to be empty.
        this.switchView(SidebarView.THUMBS);
      }
    };

    this.eventBus._on("outlineloaded", evt => {
      onTreeLoaded(evt.outlineCount, this.outlineButton, SidebarView.OUTLINE);

      evt.currentOutlineItemPromise.then(enabled => {
        if (!this.isInitialViewSet) {
          return;
        }
        this._currentOutlineItemButton.disabled = !enabled;
      });
    });

    this.eventBus._on("attachmentsloaded", evt => {
      onTreeLoaded(
        evt.attachmentsCount,
        this.attachmentsButton,
        SidebarView.ATTACHMENTS
      );
    });

    this.eventBus._on("layersloaded", evt => {
      onTreeLoaded(evt.layersCount, this.layersButton, SidebarView.LAYERS);
    });

    // Update the thumbnailViewer, if visible, when exiting presentation mode.
    this.eventBus._on("presentationmodechanged", evt => {
      if (
        evt.state === PresentationModeState.NORMAL &&
        this.visibleView === SidebarView.THUMBS
      ) {
        this.#updateThumbnailViewer();
      }
    });
  }
}

export { PDFSidebar };
