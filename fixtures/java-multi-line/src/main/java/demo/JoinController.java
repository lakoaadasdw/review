package demo;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/admin")
public class JoinController {
    private final JoinService joinService;

    public JoinController(JoinService joinService) {
        this.joinService = joinService;
    }

    @GetMapping("/join-applications")
    public Map<String, Object> list(
            @RequestParam(value = "status", required = false) String status,
            @RequestParam(value = "platform", required = false) String platform,
            @RequestParam(value = "country", required = false) String country,
            @RequestParam(value = "page", defaultValue = "1") int page,
            @RequestParam(value = "size", defaultValue = "20") int size) {
        return joinService.listApplications(status, platform, country, page, size);
    }

    @GetMapping("/simple")
    public Object simple(@RequestParam(value = "page", defaultValue = "1") int page) {
        return joinService.simple(page);
    }
}
