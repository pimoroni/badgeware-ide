import math

badge.mode(LORES | SS_X4)

scale = display.SCALE
cols = screen.width // scale
rows = screen.height // scale

def update():
    t = badge.ticks / 1000
    for y in range(rows):
        for x in range(cols):
            v = math.sin(x * 0.32 + t * 2.0) + math.sin(y * 0.41 - t * 1.4) + math.sin((x + y) * 0.18 + t)
            b = int(max(0.0, v - 0.6) / 2.4 * 200)
            screen.pen = color.rgb(b, b, b)
            screen.rectangle(x * scale, y * scale, scale, scale)

    size = 4 * scale
    bx = (math.sin(t * 1.7) + 1) / 2 * (screen.width - size)
    by = (math.cos(t * 2.3) + 1) / 2 * (screen.height - size)
    screen.pen = color.rgb(255, 255, 255)
    screen.circle(vec2(bx + size / 2, by + size / 2), size / 2)

run(update)
