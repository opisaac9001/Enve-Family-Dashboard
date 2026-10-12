#include <SDL.h>
#include <SDL_ttf.h>
#include <curl/curl.h>
#include <json-c/json.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace {
constexpr int width = 800;
constexpr int height = 480;

struct JsonDelete { void operator()(json_object *value) const { if (value) json_object_put(value); } };
using Json = std::unique_ptr<json_object, JsonDelete>;
struct Button { SDL_Rect box; std::function<void()> action; };
struct Person { std::string name, color, username, password, confirm; };
struct Reply { long status = 0; std::string body, error; };

size_t receive(char *data, size_t size, size_t count, void *context) {
  static_cast<std::string *>(context)->append(data, size * count);
  return size * count;
}

Reply request(const std::string &base, const std::string &key, const std::string &path,
              const std::string &payload = {}) {
  Reply reply;
  CURL *curl = curl_easy_init();
  if (!curl) { reply.error = "Network unavailable"; return reply; }
  auto url = base + path;
  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, receive);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &reply.body);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 4L);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 20L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
  curl_slist *headers = curl_slist_append(nullptr, "Content-Type: application/json");
  if (!key.empty()) headers = curl_slist_append(headers, ("X-Enve-Device-Key: " + key).c_str());
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  if (!payload.empty()) {
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(payload.size()));
  }
  auto code = curl_easy_perform(curl);
  if (code != CURLE_OK) reply.error = curl_easy_strerror(code);
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &reply.status);
  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);
  return reply;
}

std::string value(json_object *object, const char *name) {
  json_object *item = nullptr;
  return object && json_object_object_get_ex(object, name, &item) && item ? json_object_get_string(item) : "";
}

void add(json_object *object, const char *name, const std::string &text) {
  json_object_object_add(object, name, json_object_new_string(text.c_str()));
}

bool validLoginName(const std::string &name) {
  if (name.size() < 3 || name.size() > 30) return false;
  auto alphanumeric = [](unsigned char character) {
    return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
      (character >= '0' && character <= '9');
  };
  if (!alphanumeric(name[0])) return false;
  return std::all_of(name.begin() + 1, name.end(), [&](unsigned char character) {
    return alphanumeric(character) || character == '.' || character == '_' || character == '-';
  });
}

std::string fontPath() {
  if (auto *specified = std::getenv("ENVE_FONT")) return specified;
  for (auto *candidate : {"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
                          "/System/Library/Fonts/Supplemental/Arial.ttf"}) {
    if (FILE *file = std::fopen(candidate, "rb")) { std::fclose(file); return candidate; }
  }
  return {};
}

SDL_Color color(int red, int green, int blue) {
  return {static_cast<Uint8>(red), static_cast<Uint8>(green), static_cast<Uint8>(blue), 255};
}

SDL_Color fromHex(const std::string &text) {
  unsigned red = 245, green = 146, blue = 26;
  std::sscanf(text.c_str(), "#%02x%02x%02x", &red, &green, &blue);
  return color(red, green, blue);
}

class SetupScreen {
public:
  SetupScreen(SDL_Renderer *renderer, TTF_Font *body, TTF_Font *title,
              std::string base, std::string deviceKey)
    : renderer_(renderer), body_(body), title_(title), base_(std::move(base)), deviceKey_(std::move(deviceKey)) {
    checkServer();
  }

  bool finished() const { return finished_; }
  bool captured() const { return captured_; }
  bool dirty() const { return dirty_; }

  void resize() {
    int outputWidth, outputHeight;
    SDL_GetRendererOutputSize(renderer_, &outputWidth, &outputHeight);
    scaleX_ = static_cast<float>(outputWidth) / width;
    scaleY_ = static_cast<float>(outputHeight) / height;
    float fontScale = std::min(scaleX_, scaleY_);
    TTF_SetFontSize(body_, std::max(1, static_cast<int>(std::lround(19 * fontScale))));
    TTF_SetFontSize(title_, std::max(1, static_cast<int>(std::lround(31 * fontScale))));
    SDL_RenderSetScale(renderer_, scaleX_, scaleY_);
    dirty_ = true;
  }

  void tick() {
    if (saving_ && !dirty_) {
      complete();
      saving_ = false;
      dirty_ = true;
      return;
    }
    if (SDL_GetTicks() - lastCheck_ > 5000) {
      if (connected_) refreshNetwork();
      else checkServer();
    }
  }

  void touch(int x, int y) {
    if (saving_) return;
    for (auto button = buttons_.rbegin(); button != buttons_.rend(); ++button) {
      if (x >= button->box.x && x < button->box.x + button->box.w &&
          y >= button->box.y && y < button->box.y + button->box.h) {
        button->action(); dirty_ = true; return;
      }
    }
  }

  void text(const char *input) {
    if (!editing_) return;
    if (editing_->size() + std::strlen(input) <= 128) *editing_ += input;
    dirty_ = true;
  }

  void key(SDL_Keycode code) {
    if (editing_) {
      if (code == SDLK_BACKSPACE) eraseLast();
      if (code == SDLK_RETURN || code == SDLK_KP_ENTER || code == SDLK_ESCAPE) closeKeyboard();
    } else if (!buttons_.empty()) {
      if (code == SDLK_TAB) {
        int direction = SDL_GetModState() & KMOD_SHIFT ? -1 : 1;
        focusIndex_ = (static_cast<int>(focusIndex_) + direction + static_cast<int>(buttons_.size())) % static_cast<int>(buttons_.size());
      } else if (code == SDLK_RETURN || code == SDLK_KP_ENTER || code == SDLK_SPACE) {
        buttons_[focusIndex_ % buttons_.size()].action();
        focusIndex_ = 0;
      }
    }
    dirty_ = true;
  }

  void draw() {
    dirty_ = false;
    buttons_.clear();
    SDL_SetRenderDrawColor(renderer_, 20, 23, 29, 255);
    SDL_RenderClear(renderer_);
    fill({0, 0, width, height}, color(20, 23, 29));
    fill({0, 0, width, 58}, color(31, 36, 44));
    label("e", 20, 10, 38, title_, accent());
    label("enve family", 62, 16, 220, body_, white());
    label("SETUP", 690, 18, 95, body_, muted());
    if (!connected_) {
      label("Starting the family server", 67, 150, 690, title_, white());
      label(error_.empty() ? "Trying again in a moment…" : error_, 68, 215, 670, body_, muted());
    } else if (step_ == 0) welcome();
    else if (step_ == 1) household();
    else if (step_ == 2) access();
    else if (step_ == 3) people();
    else if (step_ == 4) adults();
    else if (step_ == 5) display();
    else connections();
    if (!error_.empty() && connected_) label(error_, 24, step_ == 4 ? 399 : 393, 750, body_, color(255, 155, 135));
    if (editing_) keyboard();
    else if (!buttons_.empty()) {
      focusIndex_ %= buttons_.size();
      auto box = buttons_[focusIndex_].box;
      box = {box.x - 2, box.y - 2, box.w + 4, box.h + 4};
      SDL_SetRenderDrawColor(renderer_, 255, 255, 255, 255);
      SDL_RenderDrawRect(renderer_, &box);
    }
    if (!captured_ && std::getenv("ENVE_CAPTURE")) {
      int outputWidth, outputHeight;
      SDL_GetRendererOutputSize(renderer_, &outputWidth, &outputHeight);
      auto *surface = SDL_CreateRGBSurfaceWithFormat(0, outputWidth, outputHeight, 32, SDL_PIXELFORMAT_ARGB8888);
      if (surface && SDL_RenderReadPixels(renderer_, nullptr, SDL_PIXELFORMAT_ARGB8888, surface->pixels, surface->pitch) == 0)
        captured_ = SDL_SaveBMP(surface, std::getenv("ENVE_CAPTURE")) == 0;
      if (surface) SDL_FreeSurface(surface);
    }
    SDL_RenderPresent(renderer_);
  }

private:
  SDL_Color accent() const { return color(245, 146, 26); }
  SDL_Color white() const { return color(244, 241, 236); }
  SDL_Color muted() const { return color(169, 179, 191); }
  SDL_Color card() const { return color(36, 42, 51); }

  void fill(SDL_Rect box, SDL_Color shade) {
    SDL_SetRenderDrawColor(renderer_, shade.r, shade.g, shade.b, shade.a);
    SDL_RenderFillRect(renderer_, &box);
  }

  void label(std::string text, int x, int y, int maxWidth, TTF_Font *font, SDL_Color shade, bool keepEnd = false) {
    int measured = 0;
    while (!text.empty() && TTF_SizeUTF8(font, text.c_str(), &measured, nullptr) == 0 && measured > maxWidth * scaleX_) {
      if (keepEnd) {
        size_t start = text.rfind("…", 0) == 0 ? std::strlen("…") : 0;
        size_t cut = start + 1;
        while (cut < text.size() && (static_cast<unsigned char>(text[cut]) & 0xc0) == 0x80) ++cut;
        text = "…" + text.substr(cut);
        if (text == "…") text.clear();
      } else {
        size_t cut = text.size() - 1;
        while (cut > 0 && (static_cast<unsigned char>(text[cut]) & 0xc0) == 0x80) --cut;
        text.resize(cut);
      }
    }
    if (text.empty()) return;
    auto *surface = TTF_RenderUTF8_Blended(font, text.c_str(), shade);
    if (!surface) return;
    auto *texture = SDL_CreateTextureFromSurface(renderer_, surface);
    SDL_Rect box{x, y, static_cast<int>(std::lround(surface->w / scaleX_)),
                 static_cast<int>(std::lround(surface->h / scaleY_))};
    if (texture) { SDL_RenderCopy(renderer_, texture, nullptr, &box); SDL_DestroyTexture(texture); }
    SDL_FreeSurface(surface);
  }

  void button(const std::string &text, SDL_Rect box, SDL_Color background, std::function<void()> action) {
    fill(box, background);
    label(text, box.x + 12, box.y + 10, box.w - 24, body_, background.r == accent().r ? color(24, 28, 34) : white());
    buttons_.push_back({box, std::move(action)});
  }

  void field(const std::string &name, std::string &text, int y, bool secret = false,
             int fieldWidth = 710, int x = 40) {
    label(name, x, y - 23, fieldWidth, body_, muted());
    fill({x, y, fieldWidth, 44}, card());
    label(text.empty() ? "Tap to enter" : secret ? std::string(text.size(), '*') : text,
          x + 15, y + 10, fieldWidth - 30, body_, text.empty() ? muted() : white(), true);
    buttons_.push_back({{x, y, fieldWidth, 44}, [this, &text, name, secret] {
      editing_ = &text; editLabel_ = name; secret_ = secret; reveal_ = false; dirty_ = true;
      SDL_StartTextInput();
    }});
  }

  void colors(std::string &selected, int y) {
    const char *choices[] = {"#6CA8DF", "#A88ADD", "#E89AB5", "#8EBF83", "#73BFC1", "#F5A65B"};
    label("Color", 40, y - 22, 100, body_, muted());
    for (int i = 0; i < 6; ++i) {
      SDL_Rect box{40 + i * 65, y, 52, 38};
      fill(box, fromHex(choices[i]));
      if (selected == choices[i]) fill({box.x + 17, box.y + 10, 18, 18}, white());
      buttons_.push_back({box, [&selected, choice = std::string(choices[i])] { selected = choice; }});
    }
  }

  void navigation(const std::string &next, std::function<void()> action) {
    if (step_ > 0) button("Back", {40, 428, 112, 40}, card(), [this] {
      step_ = step_ == 5 && (signInMode_ != "individual" || people_.empty()) ? 3 : step_ - 1;
      error_.clear();
    });
    button(next, {575, 428, 175, 40}, accent(), std::move(action));
  }

  void heading(const std::string &eyebrow, const std::string &title) {
    label(eyebrow, 40, 80, 700, body_, accent());
    label(title, 40, 109, 720, title_, white());
  }

  std::string stepTitle(int number, const std::string &name) const {
    return "STEP " + std::to_string(number) + "  ·  " + name;
  }

  std::string phoneAddress() const {
    auto hostStart = base_.find("://");
    hostStart = hostStart == std::string::npos ? 0 : hostStart + 3;
    auto hostEnd = base_.find('/', hostStart);
    auto port = base_.rfind(':', hostEnd);
    return "http://" + network_ + (port == std::string::npos || port < hostStart
      ? ":4317" : base_.substr(port, hostEnd == std::string::npos ? std::string::npos : hostEnd - port));
  }

  void openPerson(size_t index) {
    selectedPerson_ = index;
    draftName_ = index < people_.size() ? people_[index].name : "";
    draftColor_ = index < people_.size() ? people_[index].color : "#A88ADD";
    editingPerson_ = true;
    confirmRemove_ = false;
    error_.clear();
  }

  void welcome() {
    heading("WELCOME HOME", "Make this home yours.");
    label("Set up the people, colors, and sign-ins for your household.", 40, 170, 710, body_, muted());
    label("The wall display and your phones will share one calendar server.", 40, 202, 710, body_, muted());
    label(network_ == "not connected yet" ? "Network: not connected yet" : "Network: connected · " + network_,
          40, 273, 710, body_, white());
    label("Online calendars need an Internet connection.", 40, 309, 710, body_, muted());
    label("Use Ethernet or a Wi-Fi network saved on this device.", 40, 341, 710, body_, muted());
    button("Start setup", {575, 428, 175, 40}, accent(), [this] { step_ = 1; });
  }

  void household() {
    heading(stepTitle(1, "HOUSEHOLD"), "Who lives here?");
    field("Household name", householdName_, 190);
    field("Your name", ownerName_, 275);
    colors(ownerColor_, 340);
    navigation("Continue", [this] {
      if (householdName_.empty() || ownerName_.empty()) { error_ = "Enter your household and your name."; return; }
      if (householdName_.size() > 60 || ownerName_.size() > 30) { error_ = "A name is too long."; return; }
      error_.clear(); step_ = 2;
    });
  }

  void access() {
    heading(stepTitle(2, "SIGN-IN"), "Choose how to sign in.");
    button("No password", {40, 160, 220, 48}, signInMode_ == "none" ? accent() : card(), [this] { signInMode_ = "none"; });
    button("One password", {274, 160, 220, 48}, signInMode_ == "shared" ? accent() : card(), [this] { signInMode_ = "shared"; });
    button("Individual adults", {508, 160, 242, 48}, signInMode_ == "individual" ? accent() : card(), [this] { signInMode_ = "individual"; });
    if (signInMode_ == "none") {
      label("Opens on your network without signing in.", 40, 245, 710, body_, white());
      label("Anyone who reaches this device can see and change family information.", 40, 278, 710, body_, muted());
    } else {
      if (signInMode_ == "individual") field("Your sign-in name", ownerLogin_, 248);
      else label("Everyone uses one password or PIN. The wall display opens automatically.", 40, 248, 710, body_, muted());
      field("Password or PIN · 4+ characters", ownerPassword_, 333, true, 345);
      field("Repeat password or PIN", ownerConfirm_, 333, true, 345, 405);
    }
    navigation("Continue", [this] {
      if (signInMode_ == "individual" && !validLoginName(ownerLogin_)) { error_ = "Use 3–30 letters, numbers, dots, dashes, or underscores."; return; }
      if (signInMode_ != "none" && ownerPassword_.size() < 4) { error_ = "Use a password or PIN of at least 4 characters."; return; }
      if (signInMode_ != "none" && ownerPassword_ != ownerConfirm_) { error_ = "Passwords don't match. Please repeat your password."; return; }
      error_.clear(); step_ = 3;
    });
  }

  void people() {
    heading(stepTitle(3, "PEOPLE"), editingPerson_ ?
            selectedPerson_ < people_.size() ? "Edit this person." : "Add a person." : "Who else is in your home?");
    if (editingPerson_) {
      field("Name", draftName_, 203);
      colors(draftColor_, 302);
      label("Their color will help identify events and tasks.", 40, 370, 710, body_, muted());
      button("Cancel", {40, 428, 112, 40}, card(), [this] { editingPerson_ = false; error_.clear(); });
      if (selectedPerson_ < people_.size())
        button(confirmRemove_ ? "Confirm remove" : "Remove", {184, 428, 190, 40}, card(), [this] {
          if (!confirmRemove_) { confirmRemove_ = true; return; }
          people_.erase(people_.begin() + selectedPerson_);
          if (peoplePage_ * 4 >= people_.size() && peoplePage_ > 0) --peoplePage_;
          editingPerson_ = false; confirmRemove_ = false; error_.clear();
        });
      button(selectedPerson_ < people_.size() ? "Save changes" : "Add person", {575, 428, 175, 40}, accent(), [this] {
        if (draftName_.empty() || draftName_.size() > 30) { error_ = "Enter a name up to 30 characters."; return; }
        if (selectedPerson_ == people_.size()) {
          if (people_.size() >= 11) { error_ = "This home already has 12 people."; return; }
          people_.push_back({draftName_, draftColor_, {}, {}, {}});
        } else {
          people_[selectedPerson_].name = draftName_;
          people_[selectedPerson_].color = draftColor_;
        }
        peoplePage_ = selectedPerson_ / 4;
        editingPerson_ = false; error_.clear();
      });
      return;
    }
    label(people_.empty() ? "Add someone, or continue if it's just you." :
          "Tap a person to change their name or color.", 40, 156, 710, body_, muted());
    for (size_t row = 0; row < 4; ++row) {
      size_t index = peoplePage_ * 4 + row;
      if (index >= people_.size()) break;
      int y = 180 + static_cast<int>(row) * 47;
      fill({40, y, 710, 42}, card());
      fill({54, y + 11, 20, 20}, fromHex(people_[index].color));
      label(people_[index].name, 88, y + 8, 525, body_, white());
      label("Edit", 675, y + 8, 60, body_, accent());
      buttons_.push_back({{40, y, 710, 42}, [this, index] { openPerson(index); }});
    }
    if (people_.size() > 4) {
      label(std::to_string(peoplePage_ + 1) + " of " + std::to_string((people_.size() + 3) / 4),
            360, 386, 90, body_, muted());
      if (peoplePage_ > 0) button("Previous", {40, 378, 145, 39}, card(), [this] { --peoplePage_; });
      if ((peoplePage_ + 1) * 4 < people_.size())
        button("Next", {605, 378, 145, 39}, card(), [this] { ++peoplePage_; });
    }
    navigation("Continue", [this] { memberIndex_ = 0; error_.clear(); step_ = signInMode_ != "individual" || people_.empty() ? 5 : 4; });
    if (people_.size() < 11) button("Add person", {190, 428, 170, 40}, card(), [this] { openPerson(people_.size()); });
  }

  void adults() {
    heading(stepTitle(4, "ADULTS"), "Who needs a sign-in?");
    label("Leave these fields empty for children and other profiles.", 40, 159, 710, body_, muted());
    Person &person = people_[memberIndex_];
    label(person.name + "  ·  " + std::to_string(memberIndex_ + 1) + " of " + std::to_string(people_.size()),
          40, 191, 600, body_, white());
    if (memberIndex_ > 0) button("Previous", {40, 222, 150, 39}, card(), [this] { --memberIndex_; error_.clear(); });
    if (memberIndex_ + 1 < people_.size())
      button("Next person", {596, 222, 154, 39}, card(), [this] { ++memberIndex_; error_.clear(); });
    field("Sign-in name · optional", person.username, 282);
    field("Password or PIN · 4+ characters", person.password, 350, true, 345);
    field("Repeat password", person.confirm, 350, true, 345, 405);
    button("Back", {40, 428, 112, 40}, card(), [this] { step_ = 3; error_.clear(); });
    button("Continue", {575, 428, 175, 40}, accent(), [this] {
      std::string owner = ownerLogin_;
      std::transform(owner.begin(), owner.end(), owner.begin(), [](unsigned char c) { return std::tolower(c); });
      std::vector<std::string> usedNames{owner};
      for (size_t i = 0; i < people_.size(); ++i) {
        const auto &member = people_[i];
        if (member.username.empty() && member.password.empty() && member.confirm.empty()) continue;
        memberIndex_ = i;
        if (!validLoginName(member.username)) { error_ = member.name + ": check the sign-in name."; return; }
        std::string username = member.username;
        std::transform(username.begin(), username.end(), username.begin(), [](unsigned char c) { return std::tolower(c); });
        if (std::find(usedNames.begin(), usedNames.end(), username) != usedNames.end()) {
          error_ = member.name + ": use a different sign-in name."; return;
        }
        if (member.password.size() < 4) { error_ = member.name + ": password needs 4+ characters."; return; }
        if (member.password != member.confirm) { error_ = member.name + ": passwords don't match."; return; }
        usedNames.push_back(username);
      }
      error_.clear(); step_ = 5;
    });
  }

  void display() {
    heading(stepTitle(signInMode_ != "individual" || people_.empty() ? 4 : 5, "DISPLAY"), "Set the day and night look.");
    button("Follow the clock", {40, 165, 220, 46}, theme_ == "auto" ? accent() : card(), [this] { theme_ = "auto"; });
    button("Always light", {274, 165, 220, 46}, theme_ == "light" ? accent() : card(), [this] { theme_ = "light"; });
    button("Always dark", {508, 165, 242, 46}, theme_ == "dark" ? accent() : card(), [this] { theme_ = "dark"; });
    if (theme_ == "auto") {
      field("Light starts at · HH:MM", lightAt_, 250);
      field("Dark starts at · HH:MM", darkAt_, 330);
    }
    navigation("Continue", [this] {
      auto valid = [](const std::string &time) {
        return time.size() == 5 && time[2] == ':' &&
          std::isdigit(static_cast<unsigned char>(time[0])) && std::isdigit(static_cast<unsigned char>(time[1])) &&
          std::isdigit(static_cast<unsigned char>(time[3])) && std::isdigit(static_cast<unsigned char>(time[4])) &&
          time.substr(0, 2) <= "23" && time.substr(3) <= "59";
      };
      if (!valid(lightAt_) || !valid(darkAt_)) { error_ = "Use a time like 07:00."; return; }
      error_.clear(); step_ = 6;
    });
  }

  void connections() {
    heading(stepTitle(signInMode_ != "individual" || people_.empty() ? 5 : 6, "CALENDARS"), "Your home is almost ready.");
    label("Your family calendar works as soon as setup finishes.", 40, 159, 710, body_, white());
    if (network_ == "not connected yet") {
      label("Connect this Pi to your home network to use it on phones.", 40, 210, 710, body_, muted());
      label("Its phone address will appear here when it connects.", 40, 246, 710, body_, muted());
    } else {
      label("On an iPhone on the same home network, open:", 40, 207, 710, body_, muted());
      label(phoneAddress(), 40, 245, 710, title_, accent());
      label("You can add events and check lists from either phone.", 40, 296, 710, body_, muted());
    }
    label("Connect Google, iCloud, and Outlook later in Settings on a Mac.", 40, 343, 710, body_, muted());
    if (saving_) label("Saving your home…", 575, 436, 175, body_, accent());
    else navigation("Finish setup", [this] { saving_ = true; error_.clear(); });
  }

  void closeKeyboard() { editing_ = nullptr; reveal_ = false; SDL_StopTextInput(); }

  void eraseLast() {
    if (!editing_ || editing_->empty()) return;
    size_t start = editing_->size() - 1;
    while (start > 0 && (static_cast<unsigned char>((*editing_)[start]) & 0xc0) == 0x80) --start;
    editing_->erase(start);
  }

  void keyboard() {
    buttons_.clear();
    fill({0, 0, width, height}, color(19, 22, 28));
    label(editLabel_, 22, 18, secret_ ? 620 : 750, title_, white());
    if (secret_) button(reveal_ ? "Hide" : "Show", {660, 14, 115, 42}, card(), [this] { reveal_ = !reveal_; });
    label(secret_ && !reveal_ ? std::string(editing_->size(), '*') : *editing_,
          22, 63, 750, body_, muted(), true);
    const char *rows[] = {"1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm", "@.-_!#$%&*:"};
    for (int row = 0; row < 5; ++row) {
      std::string keys(rows[row]);
      int keyWidth = 710 / static_cast<int>(keys.size());
      for (size_t column = 0; column < keys.size(); ++column) {
        char letter = keys[column];
        SDL_Rect box{25 + static_cast<int>(column) * keyWidth, 113 + row * 56, keyWidth - 5, 47};
        button(std::string(1, upper_ && row > 0 && row < 4 ? static_cast<char>(std::toupper(letter)) : letter), box, card(),
               [this, letter] {
          char input[2]{upper_ ? static_cast<char>(std::toupper(letter)) : letter, '\0'};
          text(input);
        });
      }
    }
    button(upper_ ? "lower" : "SHIFT", {25, 406, 110, 52}, card(), [this] { upper_ = !upper_; });
    button("Space", {145, 406, 250, 52}, card(), [this] { text(" "); });
    button("Delete", {405, 406, 155, 52}, card(), [this] { eraseLast(); });
    button("Done", {570, 406, 205, 52}, accent(), [this] { closeKeyboard(); });
  }

  void checkServer() {
    lastCheck_ = SDL_GetTicks();
    auto reply = request(base_, deviceKey_, "/api/setup/status");
    if (!reply.error.empty() || reply.status != 200) { error_ = "Waiting for the Enve server…"; dirty_ = true; return; }
    Json data(json_tokener_parse(reply.body.c_str()));
    if (!data) { error_ = "Waiting for the Enve server…"; dirty_ = true; return; }
    connected_ = true;
    if (value(data.get(), "needed") != "true") { finished_ = true; return; }
    refreshNetwork();
    error_.clear(); dirty_ = true;
  }

  void refreshNetwork() {
    lastCheck_ = SDL_GetTicks();
    auto network = request(base_, deviceKey_, "/api/setup/network");
    Json status(json_tokener_parse(network.body.c_str()));
    if (!status || network.status != 200) return;
    json_object *interfaces = nullptr;
    std::string address;
    if (json_object_object_get_ex(status.get(), "interfaces", &interfaces) &&
        json_object_array_length(interfaces) > 0) {
      address = value(json_object_array_get_idx(interfaces, 0), "address");
    } else address = "not connected yet";
    if (network_ != address) { network_ = address; dirty_ = true; }
  }

  void complete() {
    Json payload(json_object_new_object());
    add(payload.get(), "householdName", householdName_);
    add(payload.get(), "signInMode", signInMode_);
    Json owner(json_object_new_object());
    add(owner.get(), "name", ownerName_); add(owner.get(), "color", ownerColor_);
    add(owner.get(), "username", ownerLogin_); add(owner.get(), "password", ownerPassword_);
    json_object_object_add(payload.get(), "owner", owner.release());
    Json people(json_object_new_array());
    for (const auto &person : people_) {
      Json entry(json_object_new_object());
      add(entry.get(), "name", person.name); add(entry.get(), "color", person.color);
      if (signInMode_ == "individual" && !person.username.empty()) {
        add(entry.get(), "username", person.username);
        add(entry.get(), "password", person.password);
        json_object_object_add(entry.get(), "adult", json_object_new_boolean(true));
      }
      json_object_array_add(people.get(), entry.release());
    }
    json_object_object_add(payload.get(), "people", people.release());
    Json display(json_object_new_object());
    add(display.get(), "theme", theme_); add(display.get(), "lightAt", lightAt_); add(display.get(), "darkAt", darkAt_);
    json_object_object_add(payload.get(), "display", display.release());
    auto reply = request(base_, deviceKey_, "/api/setup/complete", json_object_to_json_string(payload.get()));
    if (!reply.error.empty()) { error_ = "Couldn't reach the family server. Try again."; return; }
    if (reply.status != 201) {
      Json failure(json_tokener_parse(reply.body.c_str()));
      error_ = value(failure.get(), "error");
      if (error_.empty()) error_ = "Setup could not finish.";
      return;
    }
    ownerPassword_.clear();
    ownerConfirm_.clear();
    finished_ = true;
  }

  SDL_Renderer *renderer_;
  TTF_Font *body_, *title_;
  float scaleX_ = 1, scaleY_ = 1;
  std::string base_, deviceKey_;
  std::vector<Button> buttons_;
  std::vector<Person> people_;
  std::string householdName_, ownerName_, ownerColor_ = "#6CA8DF", ownerLogin_, ownerPassword_, ownerConfirm_;
  std::string draftName_, draftColor_ = "#A88ADD", theme_ = "auto", lightAt_ = "07:00", darkAt_ = "19:00";
  std::string error_, network_, editLabel_, signInMode_ = "shared";
  std::string *editing_ = nullptr;
  Uint32 lastCheck_ = 0;
  int step_ = 0;
  size_t memberIndex_ = 0, peoplePage_ = 0, selectedPerson_ = 0;
  size_t focusIndex_ = 0;
  bool connected_ = false, upper_ = false, secret_ = false, reveal_ = false;
  bool editingPerson_ = false, confirmRemove_ = false, saving_ = false;
  bool finished_ = false, dirty_ = true, captured_ = false;
};

std::string deviceKey() {
  const auto *path = std::getenv("ENVE_DEVICE_KEY_PATH");
  std::ifstream input(path ? path : "data/.device-key");
  std::string key;
  input >> key;
  return key;
}
}

int main() {
  SDL_SetHint(SDL_HINT_TOUCH_MOUSE_EVENTS, "0");
  if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) != 0 || TTF_Init() != 0 || curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) {
    std::fprintf(stderr, "Could not initialize setup display libraries\n"); return 1;
  }
  auto font = fontPath();
  auto *body = TTF_OpenFont(font.c_str(), 19), *title = TTF_OpenFont(font.c_str(), 31);
  if (!body || !title) { std::fprintf(stderr, "Could not open a font; set ENVE_FONT\n"); return 1; }
  std::string driver = SDL_GetCurrentVideoDriver();
  bool kiosk = driver == "KMSDRM" || driver == "kmsdrm" || std::getenv("ENVE_FULLSCREEN");
  auto *window = SDL_CreateWindow("Enve Family Setup", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                                  width, height, SDL_WINDOW_SHOWN | (kiosk ? SDL_WINDOW_FULLSCREEN_DESKTOP : SDL_WINDOW_RESIZABLE));
  if (!window) { std::fprintf(stderr, "Could not create setup window: %s\n", SDL_GetError()); return 1; }
  SDL_ShowCursor(SDL_DISABLE);
  auto *renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
  if (!renderer) renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
  if (!renderer) { std::fprintf(stderr, "Could not create setup renderer: %s\n", SDL_GetError()); return 1; }
  auto *url = std::getenv("ENVE_SERVER_URL");
  SetupScreen setup(renderer, body, title, url ? url : "http://127.0.0.1:4317", deviceKey());
  setup.resize();
  Uint32 lastMouseMotion = 0;
  while (!setup.finished()) {
    if (SDL_ShowCursor(SDL_QUERY) == SDL_ENABLE && SDL_GetTicks() - lastMouseMotion >= 2000)
      SDL_ShowCursor(SDL_DISABLE);
    setup.tick();
    if (setup.dirty()) setup.draw();
    if (setup.captured()) break;
    SDL_Event event;
    if (!SDL_WaitEventTimeout(&event, 100)) continue;
    if (event.type == SDL_QUIT) break;
    if (event.type == SDL_WINDOWEVENT && event.window.event == SDL_WINDOWEVENT_SIZE_CHANGED) setup.resize();
    if (event.type == SDL_TEXTINPUT) setup.text(event.text.text);
    if (event.type == SDL_KEYDOWN) setup.key(event.key.keysym.sym);
    if (event.type == SDL_MOUSEMOTION) {
      lastMouseMotion = SDL_GetTicks();
      SDL_ShowCursor(SDL_ENABLE);
    }
    if (event.type == SDL_MOUSEBUTTONDOWN) {
      int windowWidth, windowHeight;
      SDL_GetWindowSize(window, &windowWidth, &windowHeight);
      setup.touch(event.button.x * width / windowWidth, event.button.y * height / windowHeight);
    }
    if (event.type == SDL_FINGERDOWN) {
      SDL_ShowCursor(SDL_DISABLE);
      setup.touch(static_cast<int>(event.tfinger.x * width), static_cast<int>(event.tfinger.y * height));
    }
  }
  SDL_DestroyRenderer(renderer); SDL_DestroyWindow(window);
  TTF_CloseFont(body); TTF_CloseFont(title);
  TTF_Quit(); SDL_Quit(); curl_global_cleanup();
  return setup.finished() || setup.captured() ? 0 : 1;
}
