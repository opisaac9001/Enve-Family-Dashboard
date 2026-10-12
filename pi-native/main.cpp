#include <SDL.h>
#include <SDL_ttf.h>
#include <curl/curl.h>
#include <json-c/json.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <fstream>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace {
constexpr int width = 800;
constexpr int height = 480;
constexpr size_t maxResponse = 4 * 1024 * 1024;
constexpr Uint32 networkEvent = SDL_USEREVENT;
volatile std::sig_atomic_t stopSignal = 0;
void stopHandler(int) { stopSignal = 1; }

struct JsonDelete { void operator()(json_object *value) const { if (value) json_object_put(value); } };
using Json = std::unique_ptr<json_object, JsonDelete>;

json_object *field(json_object *object, const char *key) {
  json_object *value = nullptr;
  return object && json_object_object_get_ex(object, key, &value) ? value : nullptr;
}
std::string string(json_object *object, const char *key, const std::string &fallback = "") {
  auto *value = field(object, key);
  return value && !json_object_is_type(value, json_type_null) ? json_object_get_string(value) : fallback;
}
bool boolean(json_object *object, const char *key) { return json_object_get_boolean(field(object, key)); }
json_object *item(json_object *array, int index) { return array ? json_object_array_get_idx(array, index) : nullptr; }
int count(json_object *array) { return array ? json_object_array_length(array) : 0; }

std::tm localTime(std::time_t value) {
  std::tm result{};
  localtime_r(&value, &result);
  return result;
}
std::time_t midnight(std::time_t value) {
  auto day = localTime(value);
  day.tm_hour = day.tm_min = day.tm_sec = 0;
  day.tm_isdst = -1;
  return std::mktime(&day);
}
std::time_t addDays(std::time_t day, int days) {
  auto date = localTime(day);
  date.tm_mday += days;
  date.tm_isdst = -1;
  return std::mktime(&date);
}
std::string dateKey(std::time_t value) {
  char buffer[16];
  auto date = localTime(value);
  std::strftime(buffer, sizeof(buffer), "%Y-%m-%d", &date);
  return buffer;
}
std::string dateLabel(std::time_t value, const char *format) {
  char buffer[64];
  auto date = localTime(value);
  std::strftime(buffer, sizeof(buffer), format, &date);
  return buffer;
}
std::time_t parseInstant(const std::string &value) {
  int year, month, day, hour, minute, second = 0;
  if (std::sscanf(value.c_str(), "%d-%d-%dT%d:%d:%d", &year, &month, &day, &hour, &minute, &second) < 5) return 0;
  std::tm parts{};
  parts.tm_year = year - 1900;
  parts.tm_mon = month - 1;
  parts.tm_mday = day;
  parts.tm_hour = hour;
  parts.tm_min = minute;
  parts.tm_sec = second;
  auto zone = value.find_first_of("Z+-", 19);
  if (zone == std::string::npos) { parts.tm_isdst = -1; return std::mktime(&parts); }
  auto result = timegm(&parts);
  if (value[zone] == 'Z') return result;
  int offsetHour = 0, offsetMinute = 0;
  if (std::sscanf(value.c_str() + zone + 1, "%d:%d", &offsetHour, &offsetMinute) == 2)
    result -= (value[zone] == '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute) * 60;
  return result;
}
bool onDay(json_object *event, std::time_t day) {
  const auto start = string(event, "start"), end = string(event, "end");
  if (boolean(event, "allDay")) return start.substr(0, 10) < dateKey(addDays(day, 1)) && end.substr(0, 10) > dateKey(day);
  return parseInstant(start) < addDays(day, 1) && parseInstant(end) > day;
}
std::string eventTime(json_object *event) {
  if (boolean(event, "allDay")) return "ALL DAY";
  auto time = localTime(parseInstant(string(event, "start")));
  char buffer[16];
  std::strftime(buffer, sizeof(buffer), "%I:%M %p", &time);
  return buffer[0] == '0' ? buffer + 1 : buffer;
}

struct Result { bool state; bool unlock; bool ok; long status; std::string body; std::string error; };
struct Request { std::string method, path, body; bool state; };

size_t receive(char *data, size_t size, size_t number, void *context) {
  auto &body = *static_cast<std::string *>(context);
  size_t bytes = size * number;
  if (bytes > maxResponse - body.size()) return 0;
  body.append(data, bytes);
  return bytes;
}

class Client {
public:
  Client(std::string base, std::string key, std::string deviceKey)
    : base_(std::move(base)), key_(std::move(key)), deviceKey_(std::move(deviceKey)), worker_([this] { run(); }) {}
  ~Client() {
    { std::lock_guard lock(mutex_); stop_ = true; }
    ready_.notify_one();
    worker_.join();
  }
  void request(Request value) {
    {
      std::lock_guard lock(mutex_);
      if (value.state) queue_.erase(std::remove_if(queue_.begin(), queue_.end(), [](const Request &queued) { return queued.state; }), queue_.end());
      queue_.push_back(std::move(value));
    }
    ready_.notify_one();
  }
private:
  struct Reply { long status = 0; std::string body, error; };
  Reply perform(CURL *curl, const Request &request) {
    Reply reply;
    std::string url = base_ + request.path;
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPGET, 0L);
    curl_easy_setopt(curl, CURLOPT_POST, 0L);
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, request.method.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, request.method == "GET" ? nullptr : request.body.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, request.method == "GET" ? 0L : static_cast<long>(request.body.size()));
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &reply.body);
    auto code = curl_easy_perform(curl);
    if (code != CURLE_OK) reply.error = code == CURLE_WRITE_ERROR && reply.body.size() >= maxResponse
      ? "Response exceeded 4 MB" : curl_easy_strerror(code);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &reply.status);
    return reply;
  }
  void run() {
    CURL *curl = curl_easy_init();
    if (!curl) {
      auto *result = new Result{true, false, false, 0, "", "Network unavailable"};
      SDL_Event event{}; event.type = networkEvent; event.user.data1 = result;
      if (SDL_PushEvent(&event) < 0) delete result;
      return;
    }
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, receive);
    curl_easy_setopt(curl, CURLOPT_COOKIEFILE, "");
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 20L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 4L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_slist *headers = curl_slist_append(nullptr, "Content-Type: application/json");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    while (true) {
      Request request;
      {
        std::unique_lock lock(mutex_);
        ready_.wait(lock, [this] { return stop_ || !queue_.empty(); });
        if (stop_) break;
        request = std::move(queue_.front());
        queue_.pop_front();
      }
      auto reply = perform(curl, request);
      if (reply.status == 401 && request.path != "/api/pin/unlock") {
        Reply signedIn;
        if (!deviceKey_.empty() && (base_.rfind("http://127.0.0.1:", 0) == 0 || base_.rfind("http://localhost:", 0) == 0)) {
          auto *deviceHeaders = curl_slist_append(nullptr, "Content-Type: application/json");
          deviceHeaders = curl_slist_append(deviceHeaders, ("X-Enve-Device-Key: " + deviceKey_).c_str());
          curl_easy_setopt(curl, CURLOPT_HTTPHEADER, deviceHeaders);
          signedIn = perform(curl, {"POST", "/api/device/session", "{}", false});
          curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
          curl_slist_free_all(deviceHeaders);
        } else if (!key_.empty()) {
          Json login(json_object_new_object());
          json_object_object_add(login.get(), "key", json_object_new_string(key_.c_str()));
          signedIn = perform(curl, {"POST", "/api/login", json_object_to_json_string(login.get()), false});
        }
        if (signedIn.status == 200 && signedIn.error.empty()) reply = perform(curl, request);
        else if (!deviceKey_.empty() || !key_.empty()) { reply = std::move(signedIn); reply.error = "Display sign-in failed"; }
      }
      auto *result = new Result{request.state, request.path == "/api/pin/unlock",
                                reply.status >= 200 && reply.status < 300 && reply.error.empty(), reply.status,
                                std::move(reply.body), std::move(reply.error)};
      if (!result->ok && result->error.empty()) {
        Json message(json_tokener_parse(result->body.c_str()));
        result->error = string(message.get(), "error");
        if (result->error.size() > 100) result->error.resize(100);
        if (result->error.empty()) result->error = reply.status == 401 ? "Check the display device key"
          : "Server returned " + std::to_string(reply.status);
      }
      SDL_Event event{};
      event.type = networkEvent;
      event.user.data1 = result;
      if (SDL_PushEvent(&event) < 0) delete result;
    }
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
  }
  std::string base_, key_, deviceKey_;
  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<Request> queue_;
  bool stop_ = false;
  std::thread worker_;
};

SDL_Color rgb(int red, int green, int blue, int alpha = 255) {
  return {static_cast<Uint8>(red), static_cast<Uint8>(green), static_cast<Uint8>(blue), static_cast<Uint8>(alpha)};
}
SDL_Color hex(const std::string &value, SDL_Color fallback) {
  unsigned red, green, blue;
  if (value.size() == 7 && value[0] == '#' && std::sscanf(value.c_str() + 1, "%02x%02x%02x", &red, &green, &blue) == 3)
    return rgb(red, green, blue);
  return fallback;
}
struct Palette { SDL_Color background, card, text, muted, line, accent; };
Palette palette(bool dark) {
  return dark ? Palette{rgb(17, 21, 28), rgb(29, 34, 44), rgb(243, 243, 239), rgb(160, 169, 181), rgb(62, 68, 80), rgb(245, 146, 26)}
              : Palette{rgb(247, 245, 239), rgb(255, 255, 252), rgb(31, 37, 44), rgb(104, 112, 121), rgb(224, 225, 222), rgb(232, 126, 19)};
}

class Backlight {
public:
  Backlight() {
    if (auto *path = std::getenv("ENVE_BACKLIGHT")) path_ = path;
    if (!path_.empty()) {
      std::ifstream input(path_);
      if (!(input >> original_) || original_ < 1) path_.clear();
    }
  }
  ~Backlight() { if (last_ >= 0) write(original_); }
  void setPercent(int percent) {
    if (path_.empty()) return;
    int value = std::max(1, original_ * percent / 100);
    if (value == last_) return;
    write(value);
    last_ = value;
  }
private:
  void write(int value) {
    std::ofstream output(path_);
    if (output) output << value;
  }
  std::string path_;
  int original_ = 0, last_ = -1;
};

struct Button { SDL_Rect area; std::function<void()> action; };
enum class Page { day, week, tasks, meals, lists };

class Display {
public:
  Display(SDL_Renderer *renderer, TTF_Font *regular, TTF_Font *medium, TTF_Font *large, Client &client)
    : renderer_(renderer), regular_(regular), medium_(medium), large_(large),
      client_(client), selected_(midnight(std::time(nullptr))) {
    if (auto *page = std::getenv("ENVE_START_PAGE")) {
      std::string name(page);
      if (name == "week") page_ = Page::week;
      else if (name == "tasks") page_ = Page::tasks;
      else if (name == "meals") page_ = Page::meals;
      else if (name == "lists") page_ = Page::lists;
    }
  }
  void refresh() {
    auto start = selected_;
    auto weekday = localTime(start).tm_wday;
    start = addDays(start, -weekday);
    client_.request({"GET", "/api/state?from=" + dateKey(start) + "&to=" + dateKey(addDays(start, 14)), "", true});
    lastRefresh_ = std::time(nullptr);
  }
  void receive(Result result) {
    if (!result.ok) {
      if (result.status == 423 && pendingAction_) { pinOpen_ = true; pin_.clear(); error_.clear(); }
      else { error_ = result.error; if (result.state) online_ = false; }
      dirty_ = true; return;
    }
    online_ = true;
    if (result.unlock) {
      pinOpen_ = false;
      pin_.clear();
      if (pendingAction_) { client_.request(*pendingAction_); pendingAction_.reset(); }
      error_.clear(); dirty_ = true; return;
    }
    if (result.state) {
      Json parsed(json_tokener_parse(result.body.c_str()));
      if (!parsed || !json_object_is_type(parsed.get(), json_type_object) || !field(parsed.get(), "events")) {
        error_ = "Invalid server response"; online_ = false;
      } else { data_ = std::move(parsed); error_.clear(); online_ = true; }
    } else { pendingAction_.reset(); refresh(); }
    dirty_ = true;
  }
  void tick() {
    auto now = std::time(nullptr);
    if (now - lastRefresh_ >= 120) refresh();
    bool dark = isDark(now), dim = isDim(now), sleeping = isSleeping(now);
    if (dark != dark_ || dim != dim_ || sleeping != sleeping_ || now / 60 != lastMinute_) dirty_ = true;
    dark_ = dark; dim_ = dim; sleeping_ = sleeping; lastMinute_ = now / 60;
    backlight_.setPercent(sleeping_ ? 1 : dim_ ? 100 - dimAmount() * 100 / 255
      : dark_ && setting("night_dim", "true") == "true" ? 82 : 100);
  }
  bool dirty() const { return dirty_; }
  bool captured() const { return captured_; }
  bool ready() const { return data_ != nullptr; }
  void resize() {
    int outputWidth, outputHeight;
    SDL_GetRendererOutputSize(renderer_, &outputWidth, &outputHeight);
    scaleX_ = static_cast<float>(outputWidth) / width;
    scaleY_ = static_cast<float>(outputHeight) / height;
    float fontScale = std::min(scaleX_, scaleY_);
    TTF_SetFontSize(regular_, std::max(1, static_cast<int>(std::lround(15 * fontScale))));
    TTF_SetFontSize(medium_, std::max(1, static_cast<int>(std::lround(19 * fontScale))));
    TTF_SetFontSize(large_, std::max(1, static_cast<int>(std::lround(27 * fontScale))));
    SDL_RenderSetScale(renderer_, scaleX_, scaleY_);
    dirty_ = true;
  }
  void touch(int x, int y) {
    lastTouch_ = std::time(nullptr);
    if (sleeping_ || dim_) { sleepOverride_ = lastTouch_ + 15 * 60; sleeping_ = dim_ = false; dirty_ = true; return; }
    for (auto button = buttons_.rbegin(); button != buttons_.rend(); ++button) {
      if (x >= button->area.x && x < button->area.x + button->area.w && y >= button->area.y && y < button->area.y + button->area.h) {
        button->action(); dirty_ = true; return;
      }
    }
  }
  void draw() {
    dirty_ = false;
    buttons_.clear();
    auto p = palette(dark_);
    SDL_SetRenderDrawColor(renderer_, p.background.r, p.background.g, p.background.b, p.background.a);
    SDL_RenderClear(renderer_);
    fill({0, 0, width, height}, p.background);
    header(p);
    if (!data_) label("Connecting to the family server…", 205, 216, 450, medium_, p.muted);
    else switch (page_) {
      case Page::day: drawDay(p); break;
      case Page::week: drawWeek(p); break;
      case Page::tasks: drawTasks(p); break;
      case Page::meals: drawMeals(p); break;
      case Page::lists: drawLists(p); break;
    }
    tabs(p);
    if (!error_.empty()) { fill({210, 7, 395, 30}, rgb(155, 55, 50)); label(error_, 222, 12, 367, regular_, rgb(255, 255, 255)); }
    if (!detail_.empty()) detail(p);
    if (pinOpen_) { buttons_.clear(); pinPad(p); }
    if (dim_ || sleeping_) {
      SDL_SetRenderDrawBlendMode(renderer_, SDL_BLENDMODE_BLEND);
      fill({0, 0, width, height}, rgb(0, 0, 0, sleeping_ ? 250 : dimAmount()));
      label(dateLabel(std::time(nullptr), "%I:%M %p"), 300, 196, 300, large_, rgb(255, 255, 255));
    }
    if (!captured_ && data_ && std::getenv("ENVE_CAPTURE")) {
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
  void fill(SDL_Rect box, SDL_Color color) {
    SDL_SetRenderDrawColor(renderer_, color.r, color.g, color.b, color.a);
    SDL_RenderFillRect(renderer_, &box);
  }
  void label(std::string value, int x, int y, int maxWidth, TTF_Font *font, SDL_Color color) {
    if (value.empty()) return;
    int measured = 0;
    while (!value.empty() && TTF_SizeUTF8(font, value.c_str(), &measured, nullptr) == 0 && measured > maxWidth * scaleX_) {
      size_t cut = value.size() - 1;
      while (cut > 0 && (static_cast<unsigned char>(value[cut]) & 0xc0) == 0x80) --cut;
      value.resize(cut);
    }
    if (value.empty()) return;
    auto *surface = TTF_RenderUTF8_Blended(font, value.c_str(), color);
    if (!surface) return;
    auto *texture = SDL_CreateTextureFromSurface(renderer_, surface);
    SDL_Rect box{x, y, static_cast<int>(std::lround(surface->w / scaleX_)),
                 static_cast<int>(std::lround(surface->h / scaleY_))};
    if (texture) { SDL_RenderCopy(renderer_, texture, nullptr, &box); SDL_DestroyTexture(texture); }
    SDL_FreeSurface(surface);
  }
  void button(std::string title, SDL_Rect box, SDL_Color background, SDL_Color foreground, std::function<void()> action, bool small = false) {
    fill(box, background);
    label(title, box.x + 9, box.y + (small ? 5 : 8), box.w - 18, small ? regular_ : medium_, foreground);
    buttons_.push_back({box, std::move(action)});
  }
  json_object *array(const char *key) const { return field(data_.get(), key); }
  json_object *settings() const { return field(data_.get(), "settings"); }
  std::string setting(const char *key, const char *fallback) const { return string(settings(), key, fallback); }
  SDL_Color profileColor(const std::string &id, SDL_Color fallback) const {
    auto *profiles = array("profiles");
    for (int i = 0; i < count(profiles); ++i) if (string(item(profiles, i), "id") == id)
      return hex(string(item(profiles, i), "color"), fallback);
    return fallback;
  }
  SDL_Color eventColor(json_object *event, SDL_Color fallback) const {
    return hex(string(event, "color"), profileColor(string(event, "profileId"), fallback));
  }
  bool isDark(std::time_t now) const {
    auto theme = setting("theme", "auto");
    if (theme == "dark") return true;
    if (theme == "light") return false;
    auto current = dateLabel(now, "%H:%M"), light = setting("light_at", "07:00"), dark = setting("dark_at", "19:00");
    bool lightPeriod = light <= dark ? current >= light && current < dark : current >= light || current < dark;
    return !lightPeriod;
  }
  bool inWindow(std::string current, std::string start, std::string end) const {
    return start < end ? current >= start && current < end : current >= start || current < end;
  }
  bool isSleeping(std::time_t now) const {
    if (setting("sleep_enabled", "true") != "true" || now < sleepOverride_) return false;
    auto start = setting("sleep_at", "22:00"), end = setting("wake_at", "06:00");
    return start != end && inWindow(dateLabel(now, "%H:%M"), start, end);
  }
  bool isDim(std::time_t now) const {
    int minutes = std::max(1, std::atoi(setting("dim_after_minutes", "10").c_str()));
    return now >= lastTouch_ + minutes * 60;
  }
  int dimAmount() const { return std::clamp(std::atoi(setting("dim_amount", "75").c_str()) * 255 / 100, 0, 255); }
  void header(const Palette &p) {
    fill({0, 0, width, 54}, p.card);
    label("enve family", 18, 11, 180, large_, p.accent);
    fill({222, 24, 8, 8}, online_ ? rgb(100, 178, 122) : rgb(191, 91, 80));
    label(dateLabel(selected_, "%A, %b %e"), 242, 15, 260, medium_, p.text);
    label(dateLabel(std::time(nullptr), "%I:%M %p"), 705, 16, 91, regular_, p.muted);
    button("<", {510, 9, 39, 36}, p.background, p.text, [this] { move(-1); });
    button("Today", {556, 9, 76, 36}, p.background, p.text, [this] { selected_ = midnight(std::time(nullptr)); refresh(); });
    button(">", {639, 9, 39, 36}, p.background, p.text, [this] { move(1); });
  }
  void move(int direction) {
    selected_ = addDays(selected_, direction * (page_ == Page::week || page_ == Page::meals ? 7 : 1));
    refresh();
  }
  void tabs(const Palette &p) {
    const char *names[] = {"Day", "Week", "Tasks", "Meals", "Lists"};
    fill({0, 429, width, 51}, p.card);
    for (int i = 0; i < 5; ++i) {
      auto page = static_cast<Page>(i);
      button(names[i], {6 + i * 159, 435, 151, 39}, page_ == page ? p.accent : p.background,
             page_ == page ? rgb(24, 26, 28) : p.text, [this, page] { page_ = page; detail_.clear(); });
    }
  }
  void title(const Palette &p, const std::string &name, int x, int y) { label(name, x, y, 370, medium_, p.muted); }
  void eventRow(const Palette &p, json_object *event, int x, int y, int rowWidth, int rowHeight) {
    fill({x, y, rowWidth, rowHeight - 4}, p.card);
    fill({x, y, 5, rowHeight - 4}, eventColor(event, p.accent));
    label(eventTime(event), x + 13, y + 6, 89, regular_, p.muted);
    label(string(event, "title", "(Untitled)"), x + 107, y + 4, rowWidth - 117, medium_, p.text);
    auto name = string(event, "calendarName");
    if (!name.empty()) label(name, x + 107, y + 27, rowWidth - 117, regular_, p.muted);
    auto details = string(event, "title") + "\n" + eventTime(event) + "\n" + string(event, "notes");
    buttons_.push_back({{x, y, rowWidth, rowHeight - 4}, [this, details = std::move(details)] {
      detail_ = details;
    }});
  }
  void drawDay(const Palette &p) {
    title(p, "CALENDAR", 20, 65);
    auto *events = array("events");
    std::vector<json_object *> shown;
    for (int i = 0; i < count(events); ++i) if (onDay(item(events, i), selected_)) shown.push_back(item(events, i));
    std::sort(shown.begin(), shown.end(), [](auto *a, auto *b) { return string(a, "start") < string(b, "start"); });
    int y = 95;
    if (shown.empty()) label("Nothing on the calendar today", 23, 115, 470, medium_, p.muted);
    if (eventOffset_ >= static_cast<int>(shown.size())) eventOffset_ = 0;
    for (int index = eventOffset_; index < static_cast<int>(shown.size()) && index < eventOffset_ + 5; ++index) {
      eventRow(p, shown[index], 18, y, 482, 54); y += 57;
    }
    if (shown.size() > 5) button("More events  >", {18, 385, 180, 31}, p.card, p.text, [this, size = shown.size()] {
      eventOffset_ = eventOffset_ + 5 >= static_cast<int>(size) ? 0 : eventOffset_ + 5;
    }, true);
    fill({517, 64, 265, 350}, p.card);
    title(p, "TO DO", 531, 73);
    int taskY = 107;
    auto *tasks = array("tasks");
    for (int i = 0; i < count(tasks) && taskY < 270; ++i) {
      auto *task = item(tasks, i);
      if (boolean(task, "completed") || string(task, "dueDate") != dateKey(selected_)) continue;
      fill({531, taskY + 4, 13, 13}, profileColor(string(task, "profileId"), p.accent));
      label(string(task, "title"), 553, taskY, 211, regular_, p.text);
      taskY += 30;
    }
    if (taskY == 107) label("No tasks due", 531, 113, 220, regular_, p.muted);
    title(p, "MEALS", 531, 287);
    auto *meals = array("meals");
    int mealY = 319;
    for (int i = 0; i < count(meals) && mealY < 392; ++i) {
      auto *meal = item(meals, i);
      if (string(meal, "day") != dateKey(selected_)) continue;
      label(string(meal, "category") + "  " + string(meal, "title"), 531, mealY, 234, regular_, p.text);
      mealY += 25;
    }
    if (mealY == 319) label("No meals planned", 531, 324, 220, regular_, p.muted);
  }
  void drawWeek(const Palette &p) {
    auto start = addDays(selected_, -localTime(selected_).tm_wday);
    auto *events = array("events");
    for (int column = 0; column < 7; ++column) {
      auto day = addDays(start, column);
      int x = 9 + column * 113;
      fill({x, 66, 107, 345}, dateKey(day) == dateKey(selected_) ? p.card : p.background);
      label(dateLabel(day, "%a"), x + 8, 74, 92, regular_, p.muted);
      label(dateLabel(day, "%d"), x + 8, 95, 92, large_, p.text);
      int y = 141;
      for (int i = 0; i < count(events) && y < 348; ++i) {
        auto *event = item(events, i);
        if (!onDay(event, day)) continue;
        fill({x + 4, y, 99, 43}, p.card);
        fill({x + 4, y, 4, 43}, eventColor(event, p.accent));
        label(string(event, "title"), x + 12, y + 4, 87, regular_, p.text);
        label(eventTime(event), x + 12, y + 23, 87, regular_, p.muted);
        y += 47;
      }
      buttons_.push_back({{x, 66, 107, 345}, [this, day] { selected_ = day; page_ = Page::day; detail_.clear(); }});
    }
  }
  void drawTasks(const Palette &p) {
    title(p, "TASKS & CHORES", 20, 66);
    auto *tasks = array("tasks");
    std::vector<json_object *> pending;
    for (int i = 0; i < count(tasks); ++i) {
      auto *task = item(tasks, i);
      if (!boolean(task, "completed") && !boolean(task, "skipped")) pending.push_back(task);
    }
    if (taskOffset_ >= static_cast<int>(pending.size())) taskOffset_ = 0;
    int y = 100;
    for (int i = taskOffset_; i < static_cast<int>(pending.size()) && i < taskOffset_ + 5; ++i) {
      auto *task = pending[i];
      auto id = string(task, "id");
      fill({18, y, 764, 47}, p.card);
      fill({18, y, 5, 47}, profileColor(string(task, "profileId"), p.accent));
      label(string(task, "title"), 31, y + 6, 390, medium_, p.text);
      label(string(task, "dueDate", "Any day"), 446, y + 13, 130, regular_, p.muted);
      button("Done", {591, y + 6, 76, 34}, p.accent, rgb(27, 29, 30), [this, id] {
        client_.request({"PATCH", "/api/tasks/" + id, "{\"completed\":true}", false});
      }, true);
      button("Skip", {675, y + 6, 95, 34}, p.background, p.muted, [this, id] {
        client_.request({"PATCH", "/api/tasks/" + id, "{\"skipped\":true}", false});
      }, true);
      y += 51;
    }
    if (pending.empty()) label("All caught up", 22, 125, 350, medium_, p.muted);
    if (pending.size() > 5) {
      button("< Previous", {18, 386, 119, 31}, p.card, p.text, [this] { taskOffset_ = std::max(0, taskOffset_ - 5); }, true);
      button("Next >", {663, 386, 119, 31}, p.card, p.text,
             [this, size = pending.size()] { taskOffset_ = taskOffset_ + 5 >= static_cast<int>(size) ? 0 : taskOffset_ + 5; }, true);
    }
  }
  void drawMeals(const Palette &p) {
    title(p, "MEAL PLAN", 20, 66);
    auto start = addDays(selected_, -localTime(selected_).tm_wday);
    auto *meals = array("meals");
    for (int column = 0; column < 7; ++column) {
      auto day = addDays(start, column);
      int x = 9 + column * 113;
      fill({x, 103, 107, 307}, p.card);
      label(dateLabel(day, "%a %d"), x + 8, 112, 90, medium_, p.text);
      int y = 148;
      for (int i = 0; i < count(meals) && y < 362; ++i) {
        auto *meal = item(meals, i);
        if (string(meal, "day") != dateKey(day)) continue;
        label(string(meal, "category"), x + 8, y, 90, regular_, p.accent);
        label(string(meal, "title"), x + 8, y + 19, 90, regular_, p.text);
        y += 54;
      }
    }
  }
  void drawLists(const Palette &p) {
    auto *lists = array("lists"), *items = array("listItems");
    title(p, "HOUSEHOLD LISTS", 20, 66);
    if (listId_.empty() && count(lists)) listId_ = string(item(lists, 0), "id");
    for (int i = 0; i < count(lists) && i < 8; ++i) {
      auto *list = item(lists, i);
      auto id = string(list, "id");
      button(string(list, "name"), {17, 99 + i * 40, 205, 35}, id == listId_ ? p.accent : p.card,
             id == listId_ ? rgb(27, 29, 30) : p.text, [this, id] { listId_ = id; listOffset_ = 0; }, true);
    }
    std::vector<json_object *> entries;
    for (int i = 0; i < count(items); ++i) {
      auto *entry = item(items, i);
      if (string(entry, "listId") == listId_) entries.push_back(entry);
    }
    if (listOffset_ >= static_cast<int>(entries.size())) listOffset_ = 0;
    int y = 99;
    for (int i = listOffset_; i < static_cast<int>(entries.size()) && i < listOffset_ + 7; ++i) {
      auto *entry = entries[i];
      auto id = string(entry, "id");
      bool checked = boolean(entry, "checked");
      fill({236, y, 546, 37}, p.card);
      button(checked ? "✓" : " ", {243, y + 3, 31, 31}, checked ? p.accent : p.background, p.text, [this, id, checked] {
        pendingAction_ = Request{"PATCH", "/api/list-items/" + id,
                                 checked ? "{\"checked\":false}" : "{\"checked\":true}", false};
        client_.request(*pendingAction_);
      }, true);
      label(string(entry, "title"), 282, y + 6, 475, regular_, checked ? p.muted : p.text);
      y += 41;
    }
    if (entries.empty()) label("This list is empty", 249, 124, 350, medium_, p.muted);
    if (entries.size() > 7) {
      button("< Previous", {236, 392, 119, 31}, p.card, p.text, [this] { listOffset_ = std::max(0, listOffset_ - 7); }, true);
      button("Next >", {663, 392, 119, 31}, p.card, p.text,
             [this, size = entries.size()] { listOffset_ = listOffset_ + 7 >= static_cast<int>(size) ? 0 : listOffset_ + 7; }, true);
    }
  }
  void detail(const Palette &p) {
    SDL_SetRenderDrawBlendMode(renderer_, SDL_BLENDMODE_BLEND);
    fill({0, 0, width, height}, rgb(0, 0, 0, 190));
    fill({113, 97, 574, 283}, p.card);
    int y = 125;
    size_t start = 0;
    while (start < detail_.size() && y < 338) {
      auto end = detail_.find('\n', start);
      label(detail_.substr(start, end - start), 139, y, 520, y == 125 ? large_ : regular_, p.text);
      y += y == 125 ? 48 : 30;
      if (end == std::string::npos) break;
      start = end + 1;
    }
    button("Close", {571, 334, 92, 35}, p.accent, rgb(27, 29, 30), [this] { detail_.clear(); }, true);
  }
  void pinPad(const Palette &p) {
    SDL_SetRenderDrawBlendMode(renderer_, SDL_BLENDMODE_BLEND);
    fill({0, 0, width, height}, rgb(0, 0, 0, 190));
    fill({260, 47, 280, 388}, p.card);
    label("Parent PIN", 287, 64, 230, large_, p.text);
    label(std::string(pin_.size(), '*'), 295, 105, 210, large_, p.accent);
    for (int index = 0; index < 9; ++index) {
      auto digit = std::to_string(index + 1);
      button(digit, {282 + index % 3 * 80, 147 + index / 3 * 59, 71, 50}, p.background, p.text,
             [this, digit] { if (pin_.size() < 8) pin_ += digit; });
    }
    button("Clear", {282, 326, 71, 49}, p.background, p.text, [this] { pin_.clear(); }, true);
    button("0", {362, 326, 71, 49}, p.background, p.text, [this] { if (pin_.size() < 8) pin_ += '0'; });
    button("OK", {442, 326, 71, 49}, p.accent, rgb(27, 29, 30), [this] {
      if (pin_.size() < 4) return;
      client_.request({"POST", "/api/pin/unlock", "{\"pin\":\"" + pin_ + "\"}", false});
      pin_.clear();
    }, true);
    button("Cancel", {341, 389, 117, 34}, p.background, p.muted, [this] {
      pinOpen_ = false; pin_.clear(); pendingAction_.reset(); error_.clear();
    }, true);
  }

  SDL_Renderer *renderer_;
  TTF_Font *regular_, *medium_, *large_;
  float scaleX_ = 1, scaleY_ = 1;
  Client &client_;
  Json data_;
  std::vector<Button> buttons_;
  Page page_ = Page::day;
  std::time_t selected_, lastRefresh_ = 0, lastTouch_ = std::time(nullptr), sleepOverride_ = 0, lastMinute_ = 0;
  std::string error_, listId_, detail_;
  int eventOffset_ = 0, taskOffset_ = 0, listOffset_ = 0;
  Backlight backlight_;
  std::optional<Request> pendingAction_;
  std::string pin_;
  bool pinOpen_ = false;
  bool online_ = false, dark_ = false, dim_ = false, sleeping_ = false, dirty_ = true, captured_ = false;
};

std::string fontPath() {
  if (auto *specified = std::getenv("ENVE_FONT")) return specified;
  for (auto *candidate : {"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
                          "/System/Library/Fonts/Supplemental/Arial.ttf"}) {
    if (FILE *file = std::fopen(candidate, "rb")) { std::fclose(file); return candidate; }
  }
  return {};
}

std::string deviceKey() {
  const auto *path = std::getenv("ENVE_DEVICE_KEY_PATH");
  std::ifstream input(path ? path : "data/.device-key");
  std::string key;
  input >> key;
  return key;
}
}

int main() {
  std::signal(SIGINT, stopHandler);
  std::signal(SIGTERM, stopHandler);
  SDL_SetHint(SDL_HINT_TOUCH_MOUSE_EVENTS, "0");
  if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) != 0 || TTF_Init() != 0 || curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) {
    std::fprintf(stderr, "Could not initialize display libraries\n"); return 1;
  }
  auto font = fontPath();
  auto *regular = TTF_OpenFont(font.c_str(), 15), *medium = TTF_OpenFont(font.c_str(), 19), *large = TTF_OpenFont(font.c_str(), 27);
  if (!regular || !medium || !large) { std::fprintf(stderr, "Could not open a display font; set ENVE_FONT\n"); return 1; }
  std::string driver = SDL_GetCurrentVideoDriver();
  bool kiosk = driver == "KMSDRM" || driver == "kmsdrm" || std::getenv("ENVE_FULLSCREEN");
  auto flags = SDL_WINDOW_SHOWN | (kiosk ? SDL_WINDOW_FULLSCREEN_DESKTOP : SDL_WINDOW_RESIZABLE);
  auto *window = SDL_CreateWindow("Enve Family", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, width, height, flags);
  if (!window) { std::fprintf(stderr, "Could not create the display window: %s\n", SDL_GetError()); return 1; }
  SDL_ShowCursor(SDL_DISABLE);
  auto *renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
  if (!renderer) renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
  if (!renderer) { std::fprintf(stderr, "Could not create the display renderer: %s\n", SDL_GetError()); return 1; }
  std::string base = std::getenv("ENVE_SERVER_URL") ? std::getenv("ENVE_SERVER_URL") : "http://127.0.0.1:4317";
  if (!base.empty() && base.back() == '/') base.pop_back();
  {
    Client client(base, std::getenv("ENVE_ACCESS_KEY") ? std::getenv("ENVE_ACCESS_KEY") : "", deviceKey());
    Display display(renderer, regular, medium, large, client);
    display.resize();
    display.refresh();
    bool running = true;
    Uint32 lastMouseMotion = 0;
#ifdef ENVE_SMOKE_TEST
    bool tapped = false;
#endif
    while (running && !stopSignal) {
      if (SDL_ShowCursor(SDL_QUERY) == SDL_ENABLE && SDL_GetTicks() - lastMouseMotion >= 2000)
        SDL_ShowCursor(SDL_DISABLE);
      display.tick();
      if (display.dirty()) display.draw();
#ifdef ENVE_SMOKE_TEST
      if (!tapped && display.ready() && std::getenv("ENVE_TEST_TAP")) {
        int x = 0, y = 0;
        if (std::sscanf(std::getenv("ENVE_TEST_TAP"), "%d,%d", &x, &y) == 2) display.touch(x, y);
        tapped = true;
      }
#endif
      if (display.captured()) running = false;
      if (!running) break;
      SDL_Event event;
      if (!SDL_WaitEventTimeout(&event, 1000)) continue;
      do {
        if (event.type == SDL_QUIT) running = false;
        else if (event.type == networkEvent) {
          std::unique_ptr<Result> result(static_cast<Result *>(event.user.data1));
          display.receive(std::move(*result));
        } else if (event.type == SDL_MOUSEMOTION) {
          lastMouseMotion = SDL_GetTicks();
          SDL_ShowCursor(SDL_ENABLE);
        }
        else if (event.type == SDL_MOUSEBUTTONDOWN) {
          int windowWidth, windowHeight;
          SDL_GetWindowSize(window, &windowWidth, &windowHeight);
          display.touch(event.button.x * width / windowWidth, event.button.y * height / windowHeight);
        } else if (event.type == SDL_FINGERDOWN) {
          SDL_ShowCursor(SDL_DISABLE);
          display.touch(static_cast<int>(event.tfinger.x * width), static_cast<int>(event.tfinger.y * height));
        }
        else if (event.type == SDL_WINDOWEVENT && event.window.event == SDL_WINDOWEVENT_SIZE_CHANGED) display.resize();
        else if (event.type == SDL_WINDOWEVENT && event.window.event == SDL_WINDOWEVENT_EXPOSED) display.tick();
      } while (SDL_PollEvent(&event));
    }
  }
  SDL_DestroyRenderer(renderer);
  SDL_DestroyWindow(window);
  TTF_CloseFont(regular); TTF_CloseFont(medium); TTF_CloseFont(large);
  TTF_Quit(); SDL_Quit(); curl_global_cleanup();
}
